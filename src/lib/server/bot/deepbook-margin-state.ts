/**
 * Margin manager discovery, state inspection, order lookup, and wallet balances.
 */

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { FLOAT_SCALAR, Order, VecSet } from '@mysten/deepbook-v3';

import type { DeepBookInternalContext } from './deepbook-context.js';
import type { ManagedAccount, OwnedPoolMarginManager } from './deepbook.js';
import type { AccountBalancesSnapshot, BotAccountKey, MarginManagerSnapshot } from './types.js';
import {
	netGasUsedMist,
	normalizeMaybeAddress,
	parseNumericString,
	round
} from './deepbook-shared.js';
import { setTimeout as sleep } from 'node:timers/promises';

function createEmptyAccountBalances(): AccountBalancesSnapshot {
	return {
		source: 'static',
		accountA: { sui: 0, usdc: 0, totalUsdc: 0, updatedAt: new Date(0).toISOString() },
		accountB: { sui: 0, usdc: 0, totalUsdc: 0, updatedAt: new Date(0).toISOString() },
		totalUsdc: 0,
		updatedAt: new Date(0).toISOString()
	};
}

function isMissingObjectError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('"code":"notExists"');
}

function isInvalidInputObjectError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('The following input objects are invalid');
}

function isMissingOrderError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('big_vector') && message.includes('slice_around');
}

export async function ensureMarginManager(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<ManagedAccount> {
	if (account.marginManagerId) {
		const response = await ctx.withReadRpc('verify margin manager owner', (client) =>
			client.getObject({ id: account.marginManagerId!, options: { showContent: true } })
		).catch(() => null);
		const fields = (response?.data?.content as { fields?: Record<string, unknown> } | null)?.fields;
		const owner = normalizeMaybeAddress(fields?.owner);
		if (owner && owner !== normalizeSuiAddress(account.address)) {
			account.marginManagerId = undefined;
		}
	}

	if (!account.marginManagerId) {
		const existingManagers = await listOwnedPoolMarginManagers(ctx, account).catch(() => []);
		if (existingManagers.length > 0) {
			account.marginManagerId = existingManagers[0].managerId;
		}
	}

	if (!account.marginManagerId) {
		const tx = new Transaction();
		tx.setSender(account.address);
		const { marginManager } = ctx.sdk({});
		const created = marginManager.newMarginManagerWithInitializer(ctx.config.pool_key)(tx) as {
			manager: unknown;
			initializer: unknown;
		};
		marginManager.shareMarginManager(
			ctx.config.pool_key,
			created.manager as never,
			created.initializer as never
		)(tx);

		const response = await ctx.signAndExecute(account, tx, {
			options: { showObjectChanges: true, showEffects: true }
		});

		const managerChange = response.objectChanges?.find(
			(change: any) =>
				change.objectType?.includes('::margin_manager::MarginManager<') && change.objectId
		);

		if (!managerChange?.objectId) {
			throw new Error(`Failed to create margin manager for ${account.label}`);
		}

		account.marginManagerId = normalizeSuiAddress(managerChange.objectId);
	}

	account.balanceManagerId = await getBalanceManagerId(ctx, account.marginManagerId);
	return account;
}

export async function getBalanceManagerId(
	ctx: DeepBookInternalContext,
	marginManagerId: string
): Promise<string> {
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		const response = await ctx.withReadRpc(
			`get margin manager object ${marginManagerId}`,
			(client) =>
				client.getObject({
					id: marginManagerId,
					options: { showContent: true }
				})
		);

		const fields = (response.data?.content as { fields?: Record<string, any> } | null)?.fields;
		const balanceManagerId =
			fields?.balance_manager_id ??
			fields?.balance_manager?.fields?.balance_manager_id ??
			fields?.balance_manager?.fields?.id?.id;

		if (typeof balanceManagerId === 'string' && balanceManagerId.length > 0) {
			return normalizeSuiAddress(balanceManagerId);
		}

		if (attempt < 6) {
			await sleep(attempt * 500);
		}
	}

	throw new Error(`Balance manager id not ready for margin manager: ${marginManagerId}`);
}

export async function getMarginManagerIdsForOwner(
	ctx: DeepBookInternalContext,
	owner: string
): Promise<string[]> {
	const tx = new Transaction();
	tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_registry::get_margin_manager_ids`,
		arguments: [tx.object(ctx.packageIds.MARGIN_REGISTRY_ID), tx.pure.address(owner)],
		typeArguments: []
	});

	const result = await ctx.inspect(tx);
	const managers = VecSet(bcs.Address).parse(ctx.returnBytes(result, 0, 0));
	return managers.contents.map((managerId) => normalizeSuiAddress(managerId));
}

export async function listOwnedPoolMarginManagers(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<OwnedPoolMarginManager[]> {
	const candidateIds = new Set<string>();
	if (account.marginManagerId) {
		candidateIds.add(normalizeSuiAddress(account.marginManagerId));
	}

	for (const managerId of await getMarginManagerIdsForOwner(ctx, account.address)) {
		candidateIds.add(normalizeSuiAddress(managerId));
	}

	const managerIds = [...candidateIds];
	if (managerIds.length === 0) {
		return [];
	}

	const responses = await ctx.withReadRpc('multiGetObjects for owned margin managers', (client) =>
		client.multiGetObjects({
			ids: managerIds,
			options: { showContent: true }
		})
	);

	const results: OwnedPoolMarginManager[] = [];
	for (const response of responses) {
		const managerId = response.data?.objectId;
		if (!managerId) {
			continue;
		}
		const fields = (response.data?.content as { fields?: Record<string, unknown> } | null)?.fields;
		const owner = normalizeMaybeAddress(fields?.owner);
		const poolId = normalizeMaybeAddress(fields?.deepbook_pool);
		if (
			owner !== normalizeSuiAddress(account.address) ||
			poolId !== normalizeSuiAddress(ctx.pool.address)
		) {
			continue;
		}

		results.push({ managerId, owner, poolId });
	}

	return results;
}

export async function getAccountOpenOrders(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<string[]> {
	if (!account.balanceManagerId && !account.marginManagerId) {
		return [];
	}

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		if (!account.balanceManagerId && account.marginManagerId) {
			account.balanceManagerId = await getBalanceManagerId(ctx, account.marginManagerId);
		}

		try {
			const { deepbook } = ctx.sdk({ [account.key]: account });
			const tx = new Transaction();
			tx.setSenderIfNotSet(account.address);
			tx.add(deepbook.accountOpenOrders(ctx.config.pool_key, account.key));
			const result = await ctx.inspect(tx);
			const decoded = VecSet(bcs.u128()).parse(ctx.returnBytes(result, 0, 0));
			return decoded.contents.map((value: bigint) => value.toString());
		} catch (error) {
			if (isInvalidInputObjectError(error) || isMissingObjectError(error)) {
				return [];
			}
			throw error;
		}
	}

	return [];
}

export async function getOrder(
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	orderId: string
) {
	const { deepbook } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSenderIfNotSet(account.address);
	tx.add(deepbook.getOrder(ctx.config.pool_key, orderId));
	let result: any;
	try {
		result = await ctx.inspect(tx);
	} catch (error) {
		if (isMissingOrderError(error)) {
			return null;
		}
		throw error;
	}

	try {
		const order = Order.parse(ctx.returnBytes(result, 0, 0));
		return {
			orderId: order.order_id.toString(),
			quantity: Number(order.quantity) / ctx.baseCoin.scalar,
			filledQuantity: Number(order.filled_quantity) / ctx.baseCoin.scalar
		};
	} catch {
		return null;
	}
}

export async function getOrderIdFromTransaction(
	ctx: DeepBookInternalContext,
	txDigest: string,
	clientOrderId: string
): Promise<string | undefined> {
	const tx = await ctx.withReadRpc(`get transaction block ${txDigest}`, (client) =>
		client.getTransactionBlock({
			digest: txDigest,
			options: { showEvents: true }
		})
	);

	return extractOrderId((tx as { events?: any[] } | null)?.events, clientOrderId);
}

export async function getMarginManagerState(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<MarginManagerSnapshot> {
	if (!account.marginManagerId) {
		throw new Error(`Account ${account.label} does not have a margin manager yet`);
	}

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		if (!account.balanceManagerId) {
			account.balanceManagerId = await getBalanceManagerId(ctx, account.marginManagerId);
		}

		try {
			const { marginManager } = ctx.sdk({ [account.key]: account });
			const tx = new Transaction();
			tx.setSenderIfNotSet(account.address);
			tx.add(marginManager.managerState(ctx.config.pool_key, account.marginManagerId));
			const result = await ctx.inspect(tx);

			const currentPriceRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 11)));
			const currentPrice =
				(currentPriceRaw * ctx.baseCoin.scalar) / ctx.quoteCoin.scalar / FLOAT_SCALAR;

			return {
				managerId: normalizeSuiAddress(bcs.Address.parse(ctx.returnBytes(result, 0, 0))),
				balanceManagerId: await getBalanceManagerId(ctx, account.marginManagerId),
				riskRatio: Number(bcs.U64.parse(ctx.returnBytes(result, 0, 2))) / FLOAT_SCALAR,
				baseAsset: Number(bcs.U64.parse(ctx.returnBytes(result, 0, 3))) / ctx.baseCoin.scalar,
				quoteAsset: Number(bcs.U64.parse(ctx.returnBytes(result, 0, 4))) / ctx.quoteCoin.scalar,
				baseDebt: Number(bcs.U64.parse(ctx.returnBytes(result, 0, 5))) / ctx.baseCoin.scalar,
				quoteDebt: Number(bcs.U64.parse(ctx.returnBytes(result, 0, 6))) / ctx.quoteCoin.scalar,
				currentPrice
			};
		} catch (error) {
			if (attempt < 2 && isMissingObjectError(error)) {
				account.balanceManagerId = await getBalanceManagerId(ctx, account.marginManagerId);
				continue;
			}
			throw error;
		}
	}

	throw new Error(`Failed to load margin manager state for ${account.label}`);
}

export async function getWalletBalances(
	ctx: DeepBookInternalContext,
	accounts: Partial<Record<BotAccountKey, ManagedAccount>>,
	suiPrice: number
): Promise<AccountBalancesSnapshot> {
	const snapshot = createEmptyAccountBalances();
	const updatedAt = new Date().toISOString();
	const entries = Object.entries(accounts) as Array<[BotAccountKey, ManagedAccount | undefined]>;

	for (const [key, account] of entries) {
		if (!account) {
			continue;
		}

		const { suiBalance, usdcBalance } = await ctx.withReadRpc(
			`get wallet balances for ${account.label}`,
			async (client) => {
				const [nextSuiBalance, nextUsdcBalance] = await Promise.all([
					client.getBalance({ owner: account.address, coinType: ctx.coins.SUI.type }),
					client.getBalance({ owner: account.address, coinType: ctx.coins.USDC.type })
				]);
				return { suiBalance: nextSuiBalance, usdcBalance: nextUsdcBalance };
			}
		);

		const sui = parseNumericString(suiBalance.totalBalance) / ctx.coins.SUI.scalar;
		const usdc = parseNumericString(usdcBalance.totalBalance) / ctx.coins.USDC.scalar;
		const totalUsdc = usdc + sui * suiPrice;

		snapshot[key] = { address: account.address, sui, usdc, totalUsdc, updatedAt };
	}

	snapshot.source = 'wallet';
	snapshot.totalUsdc = snapshot.accountA.totalUsdc + snapshot.accountB.totalUsdc;
	snapshot.updatedAt = updatedAt;
	return snapshot;
}

// ── Event extraction helpers (used by execution too, exported for reuse) ──

export function extractOrderId(
	events: any[] | undefined,
	clientOrderId: string
): string | undefined {
	if (!events) {
		return undefined;
	}

	const match = events.find((event) => {
		const parsed = event.parsedJson as Record<string, unknown> | undefined;
		return (
			typeof event.type === 'string' &&
			event.type.includes('::order_info::') &&
			String(parsed?.client_order_id ?? '') === clientOrderId &&
			parsed?.order_id
		);
	});

	return match?.parsedJson?.order_id ? String(match.parsedJson.order_id) : undefined;
}

export function extractPaidFees(
	events: any[] | undefined,
	baseScalar: number,
	quoteScalar: number
): number {
	return extractPaidFeesSummary(events, baseScalar, quoteScalar).quoteEquivalent;
}

export function extractPaidFeesSummary(
	events: any[] | undefined,
	baseScalar: number,
	quoteScalar: number
): {
	amount: number;
	asset: 'base' | 'quote' | 'deep' | null;
	quoteEquivalent: number;
} {
	if (!events) {
		return { amount: 0, asset: null, quoteEquivalent: 0 };
	}

	for (const event of events) {
		if (!String(event.type ?? '').includes('::order_info::OrderInfo')) {
			continue;
		}

		const parsed = event.parsedJson as Record<string, unknown> | undefined;
		const paidFeesAtomic = parseNumericString(parsed?.paid_fees);
		if (paidFeesAtomic <= 0) {
			continue;
		}

		if (Boolean(parsed?.fee_is_deep)) {
			return {
				amount: paidFeesAtomic,
				asset: 'deep',
				quoteEquivalent: 0
			};
		}

		const isBid = Boolean(parsed?.is_bid);
		if (isBid) {
			const quoteFee = round(paidFeesAtomic / quoteScalar, 9);
			return {
				amount: quoteFee,
				asset: 'quote',
				quoteEquivalent: round(quoteFee, 9)
			};
		}

		const executedQuantity = parseNumericString(parsed?.executed_quantity);
		const cumulativeQuoteQuantity = parseNumericString(parsed?.cumulative_quote_quantity);
		const averageFillPrice =
			executedQuantity > 0 && cumulativeQuoteQuantity > 0
				? cumulativeQuoteQuantity / quoteScalar / (executedQuantity / baseScalar)
				: 0;
		const baseFee = round(paidFeesAtomic / baseScalar, 9);
		return {
			amount: baseFee,
			asset: 'base',
			quoteEquivalent: round(baseFee * averageFillPrice, 9)
		};
	}

	return { amount: 0, asset: null, quoteEquivalent: 0 };
}

export function extractGasUsedSui(response: any, suiScalar: number): number {
	const mist = netGasUsedMist(response?.effects?.gasUsed);
	return Number(mist) / suiScalar;
}
