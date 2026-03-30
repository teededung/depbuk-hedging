import type { BotDatabase } from './db.js';
import type { DeepBookService, ManagedAccount } from './deepbook.js';
import type {
	ActiveCycleState,
	BotAccountKey,
	BotConfig,
	BotLogEntry,
	CycleOrderRecord,
	MarginManagerSnapshot,
	RuntimeSnapshot
} from './types.js';

export type ManagedAccounts = Record<BotAccountKey, ManagedAccount>;
export type { ManagedAccount };

export type AutoTopupPlan = {
	account: BotAccountKey;
	reason: 'insufficient_sui' | 'insufficient_usdc';
	coinIn: 'SUI' | 'USDC';
	coinOut: 'SUI' | 'USDC';
	coinTypeIn: string;
	coinTypeOut: string;
	amountIn: number;
	requiredAmount: number;
	currentAmount: number;
	walletDepositAmount: number;
};

export type StartAccountState = {
	managerId?: string;
	openOrdersCount: number;
	baseAsset: number;
	quoteAsset: number;
	baseDebt: number;
	quoteDebt: number;
	blockingReason?: string;
	isBlocked: boolean;
};

export type StartReadinessState = Record<BotAccountKey, StartAccountState>;

export type CleanupRecoverySummary = {
	count: number;
	pnlUsd: number;
	gasUsd: number;
};

export type RetryOptions = {
	finalFailureLevel?: 'warn' | 'error';
	minRetryDelayMs?: number;
};

export type RetryFn = <T>(
	label: string,
	fn: () => Promise<T>,
	maxAttempts?: number,
	meta?: Record<string, unknown>,
	options?: RetryOptions
) => Promise<T>;

export interface RuntimeCycleContext {
	getConfig(): BotConfig;
	getService(): DeepBookService;
	getAccounts(): ManagedAccounts;
	getDb(): BotDatabase;
	getSnapshot(): RuntimeSnapshot;
	getCurrentCycleId(): number | null;
	setCurrentCycleId(id: number | null): void;
	getCurrentCycleAuxiliaryGasUsd(): number;
	setCurrentCycleAuxiliaryGasUsd(value: number): void;
	getCurrentCycleOrders(): CycleOrderRecord[];
	setCurrentCycleOrders(orders: CycleOrderRecord[]): void;
	appendLog(level: BotLogEntry['level'], message: string, meta: Record<string, unknown>): Promise<void>;
	persistCurrentOrders(): Promise<void>;
	setActiveCycle(activeCycle: ActiveCycleState): void;
	refreshSnapshot(): Promise<void>;
	setSnapshot(overrides: Partial<RuntimeSnapshot>): void;
	setAutoTopupSnapshot(overrides: Partial<RuntimeSnapshot['autoTopup']>): void;
	updateBalancesAndPreflight(
		balances: RuntimeSnapshot['balances'],
		referencePrice: number,
		startReadiness?: StartReadinessState
	): void;
	accountLabel(account: BotAccountKey): string;
	throwIfStopping(): void;
	sleepInterruptible(ms: number): Promise<void>;
	randomDelay(): Promise<void>;
	withRetry: RetryFn;
}

export interface RuntimeCleanupContext {
	getService(): DeepBookService;
	getAccounts(): ManagedAccounts | null;
	getDb(): BotDatabase | null;
	getSnapshot(): RuntimeSnapshot;
	appendLog(level: BotLogEntry['level'], message: string, meta: Record<string, unknown>): Promise<void>;
	withRetry: RetryFn;
	inspectManagedAccountState(account: ManagedAccount): Promise<StartAccountState>;
	managerNeedsCleanup(state: StartAccountState): boolean;
	resolveCleanupManagedAccounts(account: ManagedAccount): Promise<{
		managedAccounts: ManagedAccount[];
		source: 'cache' | 'chain';
		totalKnown: number;
	}>;
	cacheManagedAccountState(
		account: ManagedAccount,
		state: StartAccountState,
		options?: {
			lastCleanupAt?: string;
			lastCleanupError?: string | null;
		}
	): Promise<void>;
	getCleanupInProgress(): boolean;
	setCleanupInProgress(value: boolean): void;
	clientOrderId(): string;
	normalizeCleanupQuantity(
		quantity: number,
		lotSize: number,
		minSize: number,
		options?: { roundUp?: boolean; maxQuantity?: number }
	): number | null;
}

export type CloseState = {
	state: MarginManagerSnapshot;
	closeQuantity: number;
};

export type OpenResidualState = {
	state: MarginManagerSnapshot;
	residualQuantity: number;
};
