export type BotNetwork = 'mainnet' | 'testnet';
export type BotLifecycle =
	| 'BOOTING'
	| 'RUNNING'
	| 'STOPPING'
	| 'STOPPED'
	| 'ERROR'
	| 'CONFIG_REQUIRED';

export type BotAccountKey = 'accountA' | 'accountB';
export type BotOrderPhase = 'OPEN' | 'CLOSE';
export type BotOrderExecutionMode = 'limit' | 'market';

export interface BotConfig {
	network: BotNetwork;
	rpc_url: string;
	rpc_urls: string[];
	experimental_deeptrade_limit_ptb: boolean;
	deeptrade_orderbook_api_base: string;
	pool_key: string;
	account_a_label: string;
	account_b_label: string;
	private_key_A: string;
	private_key_B: string;
	notional_size_usd: number;
	min_hold_seconds: number;
	max_hold_seconds: number;
	max_cycles: number | null;
	slippage_tolerance: number;
	order_poll_interval_ms: number;
	maker_reprice_seconds: number;
	force_market_close_seconds: number;
	random_size_bps: number;
	min_order_delay_ms: number;
	max_order_delay_ms: number;
	open_order_execution_mode: BotOrderExecutionMode;
	close_order_execution_mode: BotOrderExecutionMode;
	auto_swap_enabled: boolean;
	auto_swap_buffer_bps: number;
	min_gas_reserve_sui: number;
	account_a_margin_manager_id?: string;
	account_b_margin_manager_id?: string;
	account_a_borrow_quote_factor: number;
	account_b_borrow_base_factor: number;
	notional_auto_reduce_floor_pct: number;
}

export interface BotConfigSummary {
	network: BotNetwork;
	rpcUrl: string;
	experimentalDeeptradeLimitPtb: boolean;
	deeptradeOrderbookApiBase: string;
	poolKey: string;
	accountALabel: string;
	accountBLabel: string;
	hasPrivateKeyA: boolean;
	hasPrivateKeyB: boolean;
	notionalSizeUsd: number;
	holdRangeSeconds: [number, number];
	maxCycles: number | null;
	slippageTolerance: number;
	settingsApplyPending: boolean;
	updatedAt?: string;
}

export interface BotSettingsView {
	network: BotNetwork;
	rpc_url: string;
	experimental_deeptrade_limit_ptb: boolean;
	deeptrade_orderbook_api_base: string;
	pool_key: string;
	account_a_label: string;
	account_b_label: string;
	notional_size_usd: number;
	min_hold_seconds: number;
	max_hold_seconds: number;
	max_cycles: number | null;
	slippage_tolerance: number;
	random_size_bps: number;
	min_order_delay_ms: number;
	max_order_delay_ms: number;
	open_order_execution_mode: BotOrderExecutionMode;
	close_order_execution_mode: BotOrderExecutionMode;
	auto_swap_enabled: boolean;
	auto_swap_buffer_bps: number;
	min_gas_reserve_sui: number;
	order_poll_interval_ms: number;
	maker_reprice_seconds: number;
	force_market_close_seconds: number;
	account_a_margin_manager_id?: string;
	account_b_margin_manager_id?: string;
	account_a_borrow_quote_factor: number;
	account_b_borrow_base_factor: number;
	notional_auto_reduce_floor_pct: number;
	has_private_key_a: boolean;
	has_private_key_b: boolean;
	updated_at: string;
}

export interface BotSettingsUpdateInput {
	network: BotNetwork;
	rpc_url: string;
	experimental_deeptrade_limit_ptb: boolean;
	deeptrade_orderbook_api_base: string;
	pool_key: string;
	account_a_label: string;
	account_b_label: string;
	private_key_A?: string;
	private_key_B?: string;
	notional_size_usd: number;
	min_hold_seconds: number;
	max_hold_seconds: number;
	max_cycles: number | null;
	slippage_tolerance: number;
	random_size_bps: number;
	min_order_delay_ms: number;
	max_order_delay_ms: number;
	open_order_execution_mode: BotOrderExecutionMode;
	close_order_execution_mode: BotOrderExecutionMode;
	auto_swap_enabled: boolean;
	auto_swap_buffer_bps: number;
	min_gas_reserve_sui: number;
	order_poll_interval_ms: number;
	maker_reprice_seconds: number;
	force_market_close_seconds: number;
	account_a_margin_manager_id?: string;
	account_b_margin_manager_id?: string;
	account_a_borrow_quote_factor: number;
	account_b_borrow_base_factor: number;
	notional_auto_reduce_floor_pct: number;
}

export interface NotionalMaxPreview {
	referencePrice: number;
	accountACeilingUsd: number;
	accountBCeilingUsd: number;
	maxAffordableNotionalUsd: number;
	recommendedNotionalUsd: number;
	headroomPercent: number;
	limitingAccount: 'accountA' | 'accountB' | 'both';
	updatedAt: string;
}

export interface BotLogEntry {
	id: number;
	level: 'debug' | 'info' | 'success' | 'warn' | 'error';
	message: string;
	meta: Record<string, unknown>;
	createdAt: string;
}

export interface CycleOrderRecord {
	account: BotAccountKey;
	side: 'LONG' | 'SHORT';
	phase: BotOrderPhase;
	isBid: boolean;
	reduceOnly: boolean;
	clientOrderId: string;
	orderId?: string;
	price: number;
	quantity: number;
	notionalUsd: number;
	txDigest?: string;
	gasUsedSui?: number;
	gasUsedUsd?: number;
	paidFeesQuote?: number;
	paidFeesAmount?: number;
	paidFeesAsset?: 'base' | 'quote' | 'deep' | null;
	filledPrice?: number;
	filledQuantity?: number;
	filledAt?: string;
	status: 'pending' | 'open' | 'filled' | 'cancelled' | 'failed';
	attempt: number;
}

export interface CycleHistoryRecord {
	id: number;
	cycleNumber: number;
	status: 'running' | 'completed' | 'stopped' | 'failed';
	plannedNotionalUsd: number;
	volumeUsd: number;
	feesUsd: number;
	gasUsd: number;
	pnlUsd: number;
	holdSecondsTarget: number;
	holdSecondsActual: number;
	openPrice: number;
	closePrice: number;
	startedAt: string;
	holdStartedAt?: string;
	completedAt?: string;
	accountAManagerId?: string;
	accountBManagerId?: string;
	orders: CycleOrderRecord[];
	note?: string;
}

export interface DashboardStats {
	totalVolumeAllTime: number;
	totalVolumeToday: number;
	totalVolumeAccountA: number;
	totalVolumeAccountB: number;
	sessionPnl: number;
	sessionFees: number;
	sessionGas: number;
	cyclesCompleted: number;
	updatedAt: string;
}

export interface PriceTick {
	source: 'deepbook-mid' | 'deeptrade-api' | 'static';
	price: number;
	updatedAt: string;
	uptimeSeconds: number;
}

export interface AccountAssetBalance {
	address?: string;
	sui: number;
	usdc: number;
	totalUsdc: number;
	updatedAt: string;
}

export interface AccountBalancesSnapshot {
	source: 'wallet' | 'static';
	accountA: AccountAssetBalance;
	accountB: AccountAssetBalance;
	totalUsdc: number;
	updatedAt: string;
}

export type PreflightState =
	| 'config-required'
	| 'waiting-price'
	| 'ready'
	| 'needs-funding'
	| 'needs-reset';

export type PreflightAccountState =
	| 'ready'
	| 'needs-swap'
	| 'deposit-required'
	| 'waiting-price'
	| 'reset-required';

export interface PreflightAccountStatus {
	account: BotAccountKey;
	label: string;
	requiredAsset: 'SUI' | 'USDC';
	requiredAmount: number;
	availableAmount: number;
	missingAmount: number;
	state: PreflightAccountState;
	autoSwapEnabled: boolean;
	autoSwapAsset?: 'SUI' | 'USDC';
	autoSwapAmountNeeded?: number;
	autoSwapAmountAvailable?: number;
	managerId?: string;
	openOrdersCount: number;
	baseAsset: number;
	quoteAsset: number;
	baseDebt: number;
	quoteDebt: number;
	blockingReason?: string;
	updatedAt: string;
}

export interface PreflightSnapshot {
	state: PreflightState;
	ready: boolean;
	referencePrice: number;
	plannedNotionalUsd: number;
	estimatedQuantitySui: number;
	configuredNotionalUsd: number;
	minNotionalUsd: number;
	effectiveNotionalUsd: number;
	autoReduced: boolean;
	autoReducedReason?: string;
	accountA: PreflightAccountStatus;
	accountB: PreflightAccountStatus;
	updatedAt: string;
}

export type AutoTopupStatus = 'idle' | 'queued' | 'completed' | 'failed';

export interface AutoTopupSnapshot {
	status: AutoTopupStatus;
	account: BotAccountKey | null;
	label?: string;
	reason?: 'insufficient_sui' | 'insufficient_usdc';
	cycleNumber?: number | null;
	coinIn?: 'SUI' | 'USDC';
	coinOut?: 'SUI' | 'USDC';
	amountIn?: number;
	amountOut?: number;
	requiredAmount?: number;
	currentAmount?: number;
	provider?: string;
	txDigest?: string;
	error?: string;
	updatedAt: string;
}

export interface ActiveCycleState {
	cycleNumber: number;
	stage: 'opening' | 'waiting_fill' | 'holding' | 'closing' | 'cleanup';
	price: number;
	holdStartedAt?: string;
	holdEndsAt?: string;
	holdSecondsTarget: number;
	plannedNotionalUsd: number;
	currentQuantity: number;
	updatedAt: string;
}

export interface RuntimeSnapshot {
	lifecycle: BotLifecycle;
	liveLabel: 'Live' | 'Offline';
	runLabel: 'RUNNING' | 'STOPPED' | 'ERROR' | 'BOOTING' | 'STOPPING';
	message: string;
	runCycleCount?: number;
	stats: DashboardStats;
	price: PriceTick;
	balances: AccountBalancesSnapshot;
	preflight: PreflightSnapshot;
	autoTopup: AutoTopupSnapshot;
	activeCycle: ActiveCycleState | null;
	history: CycleHistoryRecord[];
	logs: BotLogEntry[];
	config: BotConfigSummary | null;
	startedAt?: string;
	updatedAt: string;
}

export interface MarginManagerSnapshot {
	managerId: string;
	balanceManagerId: string;
	baseAsset: number;
	quoteAsset: number;
	baseDebt: number;
	quoteDebt: number;
	riskRatio: number;
	currentPrice: number;
}

export type AutoBalanceAccountState =
	| 'ready'
	| 'planned'
	| 'insufficient-source-asset'
	| 'blocked';

export interface AutoBalanceAccountPreview {
	account: BotAccountKey;
	label: string;
	targetAsset: 'SUI' | 'USDC';
	sourceAsset: 'SUI' | 'USDC';
	workingCapitalAmount: number;
	reserveAmount: number;
	reservePerExtraCycleUsd: number;
	targetAmount: number;
	currentAmount: number;
	shortfallAmount: number;
	estimatedSourceAmount: number;
	availableSourceAmount: number;
	state: AutoBalanceAccountState;
	reason?: string;
}

export interface AutoBalancePreview {
	targetCycles: number;
	referencePrice: number;
	accountA: AutoBalanceAccountPreview;
	accountB: AutoBalanceAccountPreview;
	shareTransfer?: {
		from: BotAccountKey;
		to: BotAccountKey;
		asset: 'USDC' | 'SUI';
		amount: number;
	} | null;
	canExecute: boolean;
	message: string;
}
