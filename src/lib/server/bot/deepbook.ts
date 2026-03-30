/**
 * DeepBookService — public façade.
 *
 * This file owns all long-lived state (config, RPC pool, cursors, cached orderbook)
 * and delegates behavior to internal modules:
 *   - deepbook-shared.ts      — pure helpers
 *   - deepbook-context.ts     — internal dependency contract type
 *   - deepbook-market-data.ts — orderbook, price, estimators
 *   - deepbook-margin-state.ts — manager discovery, state, orders, balances
 *   - deepbook-execution.ts   — order submission, swap execution
 *   - deepbook-cleanup.ts     — cancel, withdraw, repay-and-withdraw
 *
 * External consumers continue to import from './deepbook.js' only.
 */

import { bcs } from '@mysten/sui/bcs';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { Transaction } from '@mysten/sui/transactions';
import { EProvider, MetaAg, type MetaQuote } from '@7kprotocol/sdk-ts';
import {
	DeepBookConfig,
	DeepBookContract,
	MarginManagerContract,
	MarginTPSLContract,
	PoolProxyContract,
	SuiPriceServiceConnection,
	mainnetCoins,
	mainnetMarginPools,
	mainnetPackageIds,
	mainnetPools,
	mainnetPythConfigs,
	testnetCoins,
	testnetMarginPools,
	testnetPackageIds,
	testnetPools,
	testnetPythConfigs
} from '@mysten/deepbook-v3';
import { setTimeout as sleep } from 'node:timers/promises';

import type {
	AccountBalancesSnapshot,
	BotAccountKey,
	BotConfig,
	MarginManagerSnapshot
} from './types.js';
import type { DeepBookInternalContext, RpcPoolEntry, SdkBundle } from './deepbook-context.js';

// ── Re-export pure helpers so existing imports from './deepbook.js' keep working ──
export {
	extractExecutionSummaryFromEvents,
	buildLongCloseMarketRepayPlan,
	buildShortCloseMarketRepayPlan,
	buildShortCloseBaseRepayPlan,
	marketBuyCoverageTargetBase,
	buildAskMarketBorrowBaseCandidates,
	computeBidQuoteBudget
} from './deepbook-shared.js';

// ── Re-export internal helpers used by sub-modules (kept internal but accessible) ──
import {
	hexToBytes,
	parseNumericString,
	extractVaaBytesFromAccumulatorMessage
} from './deepbook-shared.js';

// ── Import sub-module functions ──
import * as marketData from './deepbook-market-data.js';
import * as marginState from './deepbook-margin-state.js';
import * as execution from './deepbook-execution.js';
import * as cleanup from './deepbook-cleanup.js';

// ── Constants ──
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000';
const MARGIN_MANAGER_REFERRALS: Partial<
	Record<'mainnet' | 'testnet', Partial<Record<string, string>>>
> = {
	mainnet: {
		SUI_USDC: '0x0eeec2155b3ced3d2b5181aff2c77bc1494a4126159c224b3d618ca8a5f2226c'
	}
};
const DEEPTRADE_STYLE_PYTH_PACKAGES: Record<
	'mainnet' | 'testnet',
	{ pythPackageId: string; wormholePackageId: string }
> = {
	mainnet: {
		pythPackageId: '0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91',
		wormholePackageId: '0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a'
	},
	testnet: {
		pythPackageId: '0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837',
		wormholePackageId: '0xf47329f4344f3bf0f8e436e2f7b485466cff300f12a166563995d3888c296a94'
	}
};
const PYTH_ACCUMULATOR_MAX_ARGUMENT_SIZE = 16 * 1024;

// ── Public types ──
type GenericSigner = Ed25519Keypair | Secp256k1Keypair | Secp256r1Keypair;

export interface ManagedAccount {
	key: BotAccountKey;
	label: string;
	signer: GenericSigner;
	address: string;
	marginManagerId?: string;
	balanceManagerId?: string;
}

export interface OrderBookTop {
	bestBid: number;
	bestAsk: number;
	tickSize: number;
	lotSize: number;
	minSize: number;
	midPrice: number;
}

export interface LivePriceQuote {
	price: number;
	source: 'deepbook-mid' | 'deeptrade-api';
}

export interface PlacedOrderResult {
	txDigest: string;
	orderId?: string;
	clientOrderId: string;
	paidFeesQuote: number;
	paidFeesAmount?: number;
	paidFeesAsset?: 'base' | 'quote' | 'deep' | null;
	gasUsedSui: number;
	filledQuantity?: number;
	filledQuoteQuantity?: number;
	averageFillPrice?: number;
	netQuoteDebt?: number;
	computedSellQuantity?: number;
	netBaseDebt?: number;
	computedQuoteBudget?: number;
	computedBuyQuantity?: number;
	preRepaidBaseQuantity?: number;
}

export interface AggregatorSwapResult {
	provider: MetaQuote['provider'];
	txDigest: string;
	gasUsedSui: number;
	amountIn: number;
	amountOut: number;
	coinTypeIn: string;
	coinTypeOut: string;
	quoteSummary?: Record<string, unknown>;
	ptbShape?: Record<string, unknown>;
}

export interface WalletTransferResult {
	txDigest: string;
	gasUsedSui?: number;
	amount: number;
	coinType: string;
}

export interface OwnedPoolMarginManager {
	managerId: string;
	owner: string;
	poolId: string;
}

// ── Signer helpers (public) ──
export function createSigner(privateKey: string): GenericSigner {
	if (privateKey.startsWith('suiprivkey')) {
		const decoded = decodeSuiPrivateKey(privateKey);
		switch (decoded.schema) {
			case 'ED25519':
				return Ed25519Keypair.fromSecretKey(decoded.secretKey);
			case 'Secp256k1':
				return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
			case 'Secp256r1':
				return Secp256r1Keypair.fromSecretKey(decoded.secretKey);
			default:
				throw new Error(`Unsupported Sui key scheme: ${decoded.schema}`);
		}
	}

	const raw = hexToBytes(privateKey);
	if (raw.length === 32) {
		return Ed25519Keypair.fromSecretKey(raw);
	}
	if (raw.length === 33) {
		return createSigner(`suiprivkey${privateKey}`);
	}
	if (raw.length === 64) {
		return Ed25519Keypair.fromSecretKey(raw.slice(0, 32));
	}

	throw new Error('Unsupported private key format. Use suiprivkey... or 32-byte hex secret.');
}

export function signerAddress(signer: GenericSigner): string {
	return signer.getPublicKey().toSuiAddress();
}

// ── DeepBookService — façade class ──

export class DeepBookService implements DeepBookInternalContext {
	#config: BotConfig;
	#rpcPool: RpcPoolEntry[];
	#readRpcCursor = 0;
	#writeRpcCursor = 0;
	#aggregatorRpcCursor = 0;
	lastOrderBookTop: OrderBookTop | null = null;

	constructor(config: BotConfig) {
		this.#config = config;
		const rpcUrls = config.rpc_urls.length > 0 ? config.rpc_urls : [config.rpc_url];
		this.#rpcPool = rpcUrls.map((url) => ({
			url,
			client: new SuiClient({ url }),
			metaAg: null
		}));
	}

	// ── DeepBookInternalContext implementation ──

	get config(): BotConfig {
		return this.#config;
	}

	get client(): SuiClient {
		return this.#rpcPool[0]!.client;
	}

	get rpcPool(): RpcPoolEntry[] {
		return this.#rpcPool;
	}

	get coins() {
		return this.#config.network === 'mainnet' ? mainnetCoins : testnetCoins;
	}

	get pools() {
		return this.#config.network === 'mainnet' ? mainnetPools : testnetPools;
	}

	get marginPools() {
		return this.#config.network === 'mainnet' ? mainnetMarginPools : testnetMarginPools;
	}

	get packageIds() {
		return this.#config.network === 'mainnet' ? mainnetPackageIds : testnetPackageIds;
	}

	get pyth() {
		return this.#config.network === 'mainnet' ? mainnetPythConfigs : testnetPythConfigs;
	}

	get pool() {
		return this.pools[this.#config.pool_key];
	}

	get marginManagerReferralId(): string | null {
		return MARGIN_MANAGER_REFERRALS[this.#config.network]?.[this.#config.pool_key] ?? null;
	}

	get experimentalDeeptradeLimitPtb(): boolean {
		return this.#config.experimental_deeptrade_limit_ptb;
	}

	get baseCoin() {
		return this.coins[this.pool.baseCoin];
	}

	get quoteCoin() {
		return this.coins[this.pool.quoteCoin];
	}

	coinScalar(coinType: string): number {
		if (coinType === this.coins.SUI.type) {
			return this.coins.SUI.scalar;
		}
		if (coinType === this.coins.USDC.type) {
			return this.coins.USDC.scalar;
		}
		return 1;
	}

	normalizeCoinAmount(coinType: string, atomicAmount: string | number | bigint): number {
		return parseNumericString(atomicAmount) / this.coinScalar(coinType);
	}

	// ── RPC pool ──

	#orderedRpcEntries(startIndex: number): RpcPoolEntry[] {
		return this.#rpcPool.map(
			(_, offset) => this.#rpcPool[(startIndex + offset) % this.#rpcPool.length]!
		);
	}

	takeRpcStartIndex(kind: 'read' | 'write' | 'aggregator'): number {
		if (this.#rpcPool.length === 0) {
			throw new Error('No RPC endpoints configured');
		}

		switch (kind) {
			case 'read': {
				const start = this.#readRpcCursor % this.#rpcPool.length;
				this.#readRpcCursor = (this.#readRpcCursor + 1) % this.#rpcPool.length;
				return start;
			}
			case 'write': {
				const start = this.#writeRpcCursor % this.#rpcPool.length;
				this.#writeRpcCursor = (this.#writeRpcCursor + 1) % this.#rpcPool.length;
				return start;
			}
			case 'aggregator': {
				const start = this.#aggregatorRpcCursor % this.#rpcPool.length;
				this.#aggregatorRpcCursor = (this.#aggregatorRpcCursor + 1) % this.#rpcPool.length;
				return start;
			}
		}
	}

	rpcEntriesForKind(kind: 'read' | 'aggregator'): RpcPoolEntry[] {
		return this.#orderedRpcEntries(this.takeRpcStartIndex(kind));
	}

	rpcEntriesFromUrl(url: string): RpcPoolEntry[] {
		const preferredIndex = this.#rpcPool.findIndex((entry) => entry.url === url);
		if (preferredIndex < 0) {
			return this.rpcEntriesForKind('read');
		}
		return this.#orderedRpcEntries(preferredIndex);
	}

	#formatRpcError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	#buildRpcFailure(operation: string, attempts: Array<{ url: string; error: unknown }>): Error {
		return new Error(
			`All RPC endpoints failed for ${operation}: ${attempts
				.map(({ url, error }) => `${url} => ${this.#formatRpcError(error)}`)
				.join(' | ')}`
		);
	}

	async withReadRpc<T>(
		operation: string,
		fn: (client: SuiClient, rpcUrl: string) => Promise<T>
	): Promise<T> {
		const attempts: Array<{ url: string; error: unknown }> = [];
		for (const entry of this.rpcEntriesForKind('read')) {
			try {
				return await fn(entry.client, entry.url);
			} catch (error) {
				attempts.push({ url: entry.url, error });
			}
		}

		throw this.#buildRpcFailure(operation, attempts);
	}

	async waitForTransaction(digest: string, preferredRpcUrl: string): Promise<void> {
		const attempts: Array<{ url: string; error: unknown }> = [];
		for (const entry of this.rpcEntriesFromUrl(preferredRpcUrl)) {
			try {
				await entry.client.waitForTransaction({
					digest,
					timeout: 15_000,
					pollInterval: 1_000
				});
				return;
			} catch (error) {
				attempts.push({ url: entry.url, error });
			}
		}

		throw this.#buildRpcFailure(`waitForTransaction ${digest}`, attempts);
	}

	metaAgForEntry(entry: RpcPoolEntry): MetaAg {
		if (!entry.metaAg) {
			entry.metaAg = new MetaAg({
				fullnodeUrl: entry.url,
				slippageBps: Math.max(1, Math.round(this.#config.slippage_tolerance * 10000))
			});
		}
		return entry.metaAg;
	}

	async quoteWithAggregator(request: {
		amountIn: string;
		coinTypeIn: string;
		coinTypeOut: string;
		signer: string;
	}): Promise<{ entry: RpcPoolEntry; quotes: MetaQuote[] }> {
		const attempts: Array<{ url: string; error: unknown }> = [];
		for (const entry of this.rpcEntriesForKind('aggregator')) {
			try {
				const quotes = await this.metaAgForEntry(entry).quote(request);
				if (quotes.length > 0) {
					return { entry, quotes };
				}
				attempts.push({
					url: entry.url,
					error: new Error('7K aggregator did not return any swap route')
				});
			} catch (error) {
				attempts.push({ url: entry.url, error });
			}
		}

		throw this.#buildRpcFailure('7K aggregator quote', attempts);
	}

	async signAndExecute(
		account: ManagedAccount,
		transaction: Transaction,
		options: Record<string, unknown> = {}
	): Promise<any> {
		const rpcEntry = this.#rpcPool[this.takeRpcStartIndex('write')]!;
		const response = (await rpcEntry.client.signAndExecuteTransaction({
			signer: account.signer,
			transaction,
			requestType: 'WaitForLocalExecution',
			...options
		})) as any;

		const status = (
			response?.effects as { status?: { status?: string; error?: string } } | undefined
		)?.status;
		if (status?.status === 'failure') {
			throw new Error(status.error ?? 'Transaction execution failed');
		}

		if (response?.digest) {
			await this.waitForTransaction(response.digest, rpcEntry.url);
			await sleep(250);
		}

		return response;
	}

	selectBestAggregatorQuote(quotes: MetaQuote[]): MetaQuote {
		if (quotes.length === 0) {
			throw new Error('7K aggregator did not return any swap route');
		}

		return [...quotes].sort(
			(a, b) =>
				Number(b.simulatedAmountOut ?? b.amountOut) - Number(a.simulatedAmountOut ?? a.amountOut)
		)[0];
	}

	#pythHermesUrl(): string {
		return this.#config.network === 'mainnet'
			? 'https://hermes.pyth.network'
			: 'https://hermes-beta.pyth.network';
	}

	async appendLatestPythUpdates(tx: Transaction): Promise<void> {
		const feedIds = [
			...new Set([this.baseCoin.feed, this.quoteCoin.feed].filter(Boolean))
		] as string[];
		if (feedIds.length === 0) {
			return;
		}
		if (!this.baseCoin.priceInfoObjectId || !this.quoteCoin.priceInfoObjectId) {
			throw new Error('DeepTrade-style limit PTB requires priceInfoObjectId for both pool coins');
		}

		const priceService = new SuiPriceServiceConnection(this.#pythHermesUrl());
		const updates = await priceService.getPriceFeedsUpdateData(feedIds);
		if (updates.length !== 1) {
			throw new Error('DeepTrade-style limit PTB requires exactly one Pyth accumulator update');
		}

		const packages = DEEPTRADE_STYLE_PYTH_PACKAGES[this.#config.network];
		const vaa = extractVaaBytesFromAccumulatorMessage(updates[0]!);
		const [verifiedVaa] = tx.moveCall({
			package: packages.wormholePackageId,
			module: 'vaa',
			function: 'parse_and_verify',
			arguments: [
				tx.object(this.pyth.wormholeStateId),
				tx.pure.vector('u8', Array.from(vaa)),
				tx.object.clock()
			]
		});
		const [priceUpdatesHotPotato] = tx.moveCall({
			package: packages.pythPackageId,
			module: 'pyth',
			function: 'create_authenticated_price_infos_using_accumulator',
			arguments: [
				tx.object(this.pyth.pythStateId),
				tx.pure(
					bcs
						.vector(bcs.U8)
						.serialize(Array.from(updates[0]!), {
							maxSize: PYTH_ACCUMULATOR_MAX_ARGUMENT_SIZE
						})
						.toBytes()
				),
				verifiedVaa,
				tx.object.clock()
			]
		});
		const updateFeeCoins = tx.splitCoins(
			tx.gas,
			feedIds.map(() => tx.pure.u64(1))
		);
		const priceInfoObjectIds = [this.baseCoin.priceInfoObjectId, this.quoteCoin.priceInfoObjectId];
		let currentHotPotato = priceUpdatesHotPotato;
		for (const [index, priceInfoObjectId] of priceInfoObjectIds.entries()) {
			[currentHotPotato] = tx.moveCall({
				package: packages.pythPackageId,
				module: 'pyth',
				function: 'update_single_price_feed',
				arguments: [
					tx.object(this.pyth.pythStateId),
					currentHotPotato,
					tx.object(priceInfoObjectId),
					updateFeeCoins[index]!,
					tx.object.clock()
				]
			});
		}
		tx.moveCall({
			package: packages.pythPackageId,
			module: 'hot_potato_vector',
			function: 'destroy',
			typeArguments: [`${packages.pythPackageId}::price_info::PriceInfo`],
			arguments: [currentHotPotato]
		});
	}

	summarizeMetaQuote(quote: MetaQuote): Record<string, unknown> {
		const summary: Record<string, unknown> = {
			provider: quote.provider,
			quoteId: quote.id,
			coinTypeIn: quote.coinTypeIn,
			coinTypeOut: quote.coinTypeOut,
			amountIn: this.normalizeCoinAmount(quote.coinTypeIn, quote.amountIn),
			amountOut: this.normalizeCoinAmount(quote.coinTypeOut, quote.amountOut),
			rawAmountOut: this.normalizeCoinAmount(quote.coinTypeOut, quote.rawAmountOut)
		};

		if (quote.simulatedAmountOut) {
			summary.simulatedAmountOut = this.normalizeCoinAmount(
				quote.coinTypeOut,
				quote.simulatedAmountOut
			);
		}

		if (quote.gasUsed) {
			summary.gasUsed = {
				computationCost: quote.gasUsed.computationCost,
				storageCost: quote.gasUsed.storageCost,
				storageRebate: quote.gasUsed.storageRebate,
				nonRefundableStorageFee: quote.gasUsed.nonRefundableStorageFee
			};
		}

		if (quote.provider === EProvider.BLUEFIN7K) {
			const routes = quote.quote.routes ?? [];
			summary.routeCount = routes.length;
			summary.swapCount = quote.quote.swaps.length;
			summary.routeDexes = Array.from(
				new Set(routes.flatMap((route: any) => route.hops.map((hop: any) => hop.pool.type)))
			).slice(0, 8);
			summary.routeHops = routes
				.slice(0, 4)
				.map((route: any) => route.hops.map((hop: any) => hop.pool.type).join(' -> '));
			summary.routeShares = routes.slice(0, 4).map((route: any) => route.share ?? null);
			if (quote.quote.warning) {
				summary.warning = quote.quote.warning;
			}
			if (quote.quote.priceImpact != null) {
				summary.priceImpact = quote.quote.priceImpact;
			}
			if (quote.quote.marketSp) {
				summary.marketSp = quote.quote.marketSp;
			}
			return summary;
		}

		if (quote.provider === EProvider.OKX) {
			summary.routeCount = quote.quote.routerResult.dexRouterList.length;
			summary.routeDexes = quote.quote.routerResult.dexRouterList
				.map((route: any) => route.dexProtocol.dexName)
				.slice(0, 8);
			summary.router = quote.quote.routerResult.router;
			summary.priceImpact = quote.quote.routerResult.priceImpactPercent;
			summary.tradeFee = quote.quote.routerResult.tradeFee;
			return summary;
		}

		const genericQuote = quote.quote as Record<string, unknown>;
		const genericRoutes = Array.isArray(genericQuote['routes']) ? genericQuote['routes'] : [];
		if (genericRoutes.length > 0) {
			summary.routeCount = genericRoutes.length;
		}

		return summary;
	}

	sdk(accounts: Partial<Record<BotAccountKey, ManagedAccount>>): SdkBundle {
		const balanceManagers = Object.fromEntries(
			Object.values(accounts)
				.filter((account): account is ManagedAccount => Boolean(account?.balanceManagerId))
				.map((account) => [account.key, { address: account.balanceManagerId! }])
		);

		const marginManagers = Object.fromEntries(
			Object.values(accounts)
				.filter((account): account is ManagedAccount => Boolean(account?.marginManagerId))
				.map((account) => [
					account.key,
					{ address: account.marginManagerId!, poolKey: this.#config.pool_key }
				])
		);

		const config = new DeepBookConfig({
			address: ZERO_ADDRESS,
			network: this.#config.network,
			coins: this.coins,
			pools: this.pools,
			marginPools: this.marginPools,
			balanceManagers,
			marginManagers,
			packageIds: this.packageIds,
			pyth: this.pyth
		});

		return {
			config,
			deepbook: new DeepBookContract(config),
			marginManager: new MarginManagerContract(config),
			marginTPSL: new MarginTPSLContract(config),
			poolProxy: new PoolProxyContract(config)
		};
	}

	async inspect(tx: Transaction): Promise<any> {
		const sender = tx.getData().sender ?? ZERO_ADDRESS;
		const result = await this.withReadRpc('devInspectTransactionBlock', (client) =>
			client.devInspectTransactionBlock({
				sender,
				transactionBlock: tx
			})
		);

		const status = (result.effects as { status?: { status?: string; error?: string } })?.status;
		if (status?.status === 'failure') {
			throw new Error(status.error ?? 'DeepBook dry-run failed');
		}

		return result;
	}

	returnBytes(result: any, commandIndex: number, returnIndex = 0): Uint8Array {
		const raw = result.results?.[commandIndex]?.returnValues?.[returnIndex]?.[0];
		if (!raw) {
			throw new Error(`Missing dev inspect return value at ${commandIndex}:${returnIndex}`);
		}
		return new Uint8Array(raw);
	}

	// ── Public API — delegates to sub-modules ──

	buildManagedAccounts(): Record<BotAccountKey, ManagedAccount> {
		const accountA = createSigner(this.#config.private_key_A);
		const accountB = createSigner(this.#config.private_key_B);

		return {
			accountA: {
				key: 'accountA',
				label: this.#config.account_a_label,
				signer: accountA,
				address: signerAddress(accountA),
				marginManagerId: this.#config.account_a_margin_manager_id
			},
			accountB: {
				key: 'accountB',
				label: this.#config.account_b_label,
				signer: accountB,
				address: signerAddress(accountB),
				marginManagerId: this.#config.account_b_margin_manager_id
			}
		};
	}

	// Market data
	async getOrderBookTop(
		accounts: Partial<Record<BotAccountKey, ManagedAccount>>
	): Promise<OrderBookTop> {
		return marketData.getOrderBookTop(this, accounts);
	}

	async estimateMarketQuoteOut(baseQuantity: number): Promise<number> {
		return marketData.estimateMarketQuoteOut(this, baseQuantity);
	}

	async estimateMarketBaseOut(quoteQuantity: number): Promise<number> {
		return marketData.estimateMarketBaseOut(this, quoteQuantity);
	}

	async estimateMarketBuyQuantityForBaseTarget(input: {
		targetBase: number;
		maxQuoteQuantity: number;
		lotSize: number;
		minSize: number;
	}): Promise<{ quantity: number; quoteIn: number } | null> {
		return marketData.estimateMarketBuyQuantityForBaseTarget(this, input);
	}

	async estimateMarketSellQuantityForQuoteTarget(input: {
		targetQuote: number;
		maxBaseQuantity: number;
		lotSize: number;
		minSize: number;
	}): Promise<{ quantity: number; quoteOut: number } | null> {
		return marketData.estimateMarketSellQuantityForQuoteTarget(this, input);
	}

	async getLivePriceQuote(
		accounts: Partial<Record<BotAccountKey, ManagedAccount>>
	): Promise<LivePriceQuote> {
		return marketData.getLivePriceQuote(this, accounts);
	}

	async getLivePrice(accounts: Partial<Record<BotAccountKey, ManagedAccount>>): Promise<number> {
		return marketData.getLivePrice(this, accounts);
	}

	// Margin state
	async ensureMarginManager(account: ManagedAccount): Promise<ManagedAccount> {
		return marginState.ensureMarginManager(this, account);
	}

	async getBalanceManagerId(marginManagerId: string): Promise<string> {
		return marginState.getBalanceManagerId(this, marginManagerId);
	}

	async getMarginManagerIdsForOwner(owner: string): Promise<string[]> {
		return marginState.getMarginManagerIdsForOwner(this, owner);
	}

	async listOwnedPoolMarginManagers(account: ManagedAccount): Promise<OwnedPoolMarginManager[]> {
		return marginState.listOwnedPoolMarginManagers(this, account);
	}

	async getAccountOpenOrders(account: ManagedAccount): Promise<string[]> {
		return marginState.getAccountOpenOrders(this, account);
	}

	async getOrder(account: ManagedAccount, orderId: string) {
		return marginState.getOrder(this, account, orderId);
	}

	async getOrderIdFromTransaction(
		txDigest: string,
		clientOrderId: string
	): Promise<string | undefined> {
		return marginState.getOrderIdFromTransaction(this, txDigest, clientOrderId);
	}

	async getMarginManagerState(account: ManagedAccount): Promise<MarginManagerSnapshot> {
		return marginState.getMarginManagerState(this, account);
	}

	async getWalletBalances(
		accounts: Partial<Record<BotAccountKey, ManagedAccount>>,
		suiPrice: number
	): Promise<AccountBalancesSnapshot> {
		return marginState.getWalletBalances(this, accounts, suiPrice);
	}

	// Execution
	async swapExactInWithAggregator(input: {
		account: ManagedAccount;
		coinTypeIn: string;
		coinTypeOut: string;
		amountIn: number;
		useGasCoin?: boolean;
	}): Promise<AggregatorSwapResult> {
		return execution.swapExactInWithAggregator(this, input);
	}

	async transferUsdcBetweenAccounts(input: {
		from: ManagedAccount;
		to: ManagedAccount;
		amount: number;
	}): Promise<WalletTransferResult> {
		return execution.transferUsdcBetweenAccounts(this, input);
	}

	async transferSuiBetweenAccounts(input: {
		from: ManagedAccount;
		to: ManagedAccount;
		amount: number;
	}): Promise<WalletTransferResult> {
		return execution.transferSuiBetweenAccounts(this, input);
	}

	async placeMarginLimitOrder(input: {
		account: ManagedAccount;
		clientOrderId: string;
		price: number;
		quantity: number;
		isBid: boolean;
		setMarginManagerReferral?: boolean;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}): Promise<PlacedOrderResult> {
		return execution.placeMarginLimitOrder(this, input);
	}

	async placeMarginLimitOrderDeeptradeStyle(input: {
		account: ManagedAccount;
		clientOrderId: string;
		price: number;
		quantity: number;
		isBid: boolean;
		setMarginManagerReferral?: boolean;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}): Promise<PlacedOrderResult> {
		return execution.placeMarginLimitOrderDeeptradeStyle(this, input);
	}

	async placeMarginMarketOrder(input: {
		account: ManagedAccount;
		clientOrderId: string;
		quantity: number;
		isBid: boolean;
		setMarginManagerReferral?: boolean;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}): Promise<PlacedOrderResult> {
		return execution.placeMarginMarketOrder(this, input);
	}

	async placeLongCloseMarketOrderAndRepayQuote(input: {
		account: ManagedAccount;
		clientOrderId: string;
		targetQuoteDebt: number;
		maxBaseQuantity: number;
	}): Promise<PlacedOrderResult> {
		return execution.placeLongCloseMarketOrderAndRepayQuote(this, input);
	}

	async placeShortCloseMarketOrderAndRepayBase(input: {
		account: ManagedAccount;
		clientOrderId: string;
		targetBaseDebt: number;
		maxQuoteQuantity: number;
	}): Promise<PlacedOrderResult> {
		return execution.placeShortCloseMarketOrderAndRepayBase(this, input);
	}

	async placeReduceOnlyMarginMarketOrder(input: {
		account: ManagedAccount;
		clientOrderId: string;
		quantity: number;
		isBid: boolean;
	}): Promise<PlacedOrderResult> {
		return execution.placeReduceOnlyMarginMarketOrder(this, input);
	}

	async placeReduceOnlyMarginLimitOrder(input: {
		account: ManagedAccount;
		clientOrderId: string;
		price: number;
		quantity: number;
		isBid: boolean;
	}): Promise<PlacedOrderResult> {
		return execution.placeReduceOnlyMarginLimitOrder(this, input);
	}

	// Cleanup
	async cancelAllOrders(account: ManagedAccount): Promise<void> {
		return cleanup.cancelAllOrders(this, account);
	}

	async withdrawSettled(account: ManagedAccount): Promise<{ txDigest: string; gasUsedSui: number }> {
		return cleanup.withdrawSettled(this, account);
	}

	async repayFromManagerAndWithdraw(
		account: ManagedAccount
	): Promise<{ txDigest: string; gasUsedSui: number }> {
		return cleanup.repayFromManagerAndWithdraw(this, account);
	}

	async cancelAllConditionalOrders(account: ManagedAccount): Promise<void> {
		return cleanup.cancelAllConditionalOrders(this, account);
	}

	async compactCleanupWithdraw(account: ManagedAccount): Promise<void> {
		return cleanup.compactCleanupWithdraw(this, account);
	}

	async repayAndWithdrawAll(account: ManagedAccount): Promise<void> {
		return cleanup.repayAndWithdrawAll(this, account);
	}
}
