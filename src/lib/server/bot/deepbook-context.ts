/**
 * Internal dependency contract for deepbook sub-modules.
 * Defines the shape that DeepBookService exposes to its collaborators
 * without creating circular imports.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import type { MetaAg, MetaQuote } from '@7kprotocol/sdk-ts';
import type {
	DeepBookConfig,
	DeepBookContract,
	MarginManagerContract,
	MarginTPSLContract,
	PoolProxyContract
} from '@mysten/deepbook-v3';

import type { ManagedAccount, OrderBookTop } from './deepbook.js';
import type { BotAccountKey, BotConfig } from './types.js';

export type RpcPoolEntry = {
	url: string;
	client: SuiClient;
	metaAg: MetaAg | null;
};

export type SdkBundle = {
	config: DeepBookConfig;
	deepbook: DeepBookContract;
	marginManager: MarginManagerContract;
	marginTPSL: MarginTPSLContract;
	poolProxy: PoolProxyContract;
};

export type CoinConfig = {
	type: string;
	scalar: number;
	feed?: string;
	priceInfoObjectId?: string;
};

/**
 * Internal context interface that sub-modules receive from the façade.
 * Each sub-module only uses the subset it needs, but they all share this shape.
 */
export interface DeepBookInternalContext {
	// Config
	readonly config: BotConfig;
	readonly baseCoin: CoinConfig;
	readonly quoteCoin: CoinConfig;

	// Network config accessors
	readonly coins: any;
	readonly pools: any;
	readonly marginPools: any;
	readonly packageIds: any;
	readonly pyth: any;
	readonly pool: any;
	readonly marginManagerReferralId: string | null;
	readonly experimentalDeeptradeLimitPtb: boolean;

	// RPC pool
	rpcEntriesForKind(kind: 'read' | 'aggregator'): RpcPoolEntry[];
	rpcEntriesFromUrl(url: string): RpcPoolEntry[];
	takeRpcStartIndex(kind: 'read' | 'write' | 'aggregator'): number;
	readonly rpcPool: RpcPoolEntry[];

	// SDK
	sdk(accounts: Partial<Record<BotAccountKey, ManagedAccount>>): SdkBundle;

	// RPC operations
	withReadRpc<T>(
		operation: string,
		fn: (client: SuiClient, rpcUrl: string) => Promise<T>
	): Promise<T>;
	waitForTransaction(digest: string, preferredRpcUrl: string): Promise<void>;
	signAndExecute(
		account: ManagedAccount,
		transaction: Transaction,
		options?: Record<string, unknown>
	): Promise<any>;
	inspect(tx: Transaction): Promise<any>;
	returnBytes(result: any, commandIndex: number, returnIndex?: number): Uint8Array;

	// Aggregator
	quoteWithAggregator(request: {
		amountIn: string;
		coinTypeIn: string;
		coinTypeOut: string;
		signer: string;
	}): Promise<{ entry: RpcPoolEntry; quotes: MetaQuote[] }>;
	metaAgForEntry(entry: RpcPoolEntry): MetaAg;
	selectBestAggregatorQuote(quotes: MetaQuote[]): MetaQuote;
	summarizeMetaQuote(quote: MetaQuote): Record<string, unknown>;

	// Pyth
	appendLatestPythUpdates(tx: Transaction): Promise<void>;

	// Coin helpers
	coinScalar(coinType: string): number;
	normalizeCoinAmount(coinType: string, atomicAmount: string | number | bigint): number;

	// Shared mutable state
	lastOrderBookTop: OrderBookTop | null;
}
