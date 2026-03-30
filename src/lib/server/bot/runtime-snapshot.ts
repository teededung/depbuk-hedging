import type {
	BotAccountKey,
	BotConfig,
	RuntimeSnapshot,
	AutoBalanceAccountPreview,
	AutoBalancePreview,
	CycleHistoryRecord
} from './types.js';
import type { StartAccountState, StartReadinessState } from './runtime-context.js';
import {
	createEmptyBalances,
	createEmptyPreflight,
	createEmptyAutoTopup,
	createSnapshotDefaults
} from '$lib/runtime-snapshot-defaults.js';
import { defaultAccountLabel, nowIso, round } from './runtime-shared.js';

function accountTargetAsset(accountKey: BotAccountKey): 'SUI' | 'USDC' {
	return accountKey === 'accountA' ? 'SUI' : 'USDC';
}

function accountSwapSourceAsset(accountKey: BotAccountKey): 'SUI' | 'USDC' {
	return accountKey === 'accountA' ? 'USDC' : 'SUI';
}

function roundAssetAmount(amount: number, asset: 'SUI' | 'USDC'): number {
	return round(amount, asset === 'SUI' ? 9 : 6);
}

function safetyMultiplier(config: BotConfig): number {
	return 1 + config.auto_swap_buffer_bps / 10000 + Math.max(config.slippage_tolerance, 0);
}

function requiredFundingAmount(input: {
	accountKey: BotAccountKey;
	config: BotConfig;
	plannedNotionalUsd: number;
	referencePrice: number;
}): number {
	const { accountKey, config, plannedNotionalUsd, referencePrice } = input;
	const bufferMultiplier = 1 + config.auto_swap_buffer_bps / 10000;

	if (accountKey === 'accountA') {
		return roundAssetAmount(
			((plannedNotionalUsd / Math.max(config.account_a_borrow_quote_factor, 1)) *
				bufferMultiplier) /
				referencePrice,
			'SUI'
		);
	}

	return roundAssetAmount(
		(plannedNotionalUsd / Math.max(config.account_b_borrow_base_factor, 1)) * bufferMultiplier,
		'USDC'
	);
}

function availableTargetAssetAmount(input: {
	accountKey: BotAccountKey;
	balance: RuntimeSnapshot['balances']['accountA'];
	config: BotConfig;
}): number {
	const { accountKey, balance, config } = input;
	if (accountKey === 'accountA') {
		return roundAssetAmount(Math.max(balance.sui - config.min_gas_reserve_sui, 0), 'SUI');
	}

	return roundAssetAmount(Math.max(balance.usdc, 0), 'USDC');
}

function availableSwapSourceAmount(input: {
	accountKey: BotAccountKey;
	balance: RuntimeSnapshot['balances']['accountA'];
	config: BotConfig;
}): number {
	const { accountKey, balance, config } = input;
	if (accountKey === 'accountA') {
		return roundAssetAmount(Math.max(balance.usdc, 0), 'USDC');
	}

	return roundAssetAmount(Math.max(balance.sui - config.min_gas_reserve_sui, 0), 'SUI');
}

function estimateSourceSwapAmount(input: {
	accountKey: BotAccountKey;
	missingTargetAmount: number;
	config: BotConfig;
	referencePrice: number;
}): number {
	const { accountKey, missingTargetAmount, config, referencePrice } = input;
	if (missingTargetAmount <= 0) {
		return 0;
	}

	if (accountKey === 'accountA') {
		return roundAssetAmount(
			missingTargetAmount * referencePrice * safetyMultiplier(config),
			'USDC'
		);
	}

	return roundAssetAmount(
		(missingTargetAmount / referencePrice) * safetyMultiplier(config),
		'SUI'
	);
}

export { createEmptyBalances, createEmptyPreflight, createEmptyAutoTopup };
export { createEmptyPreflightAccount } from '$lib/runtime-snapshot-defaults.js';

export function createEmptyStartAccountState(): StartAccountState {
	return {
		openOrdersCount: 0,
		baseAsset: 0,
		quoteAsset: 0,
		baseDebt: 0,
		quoteDebt: 0,
		isBlocked: false
	};
}

export function createEmptyStartReadiness(): StartReadinessState {
	return {
		accountA: createEmptyStartAccountState(),
		accountB: createEmptyStartAccountState()
	};
}

export function createSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
	return {
		message: 'Initializing DeepBook hedging runtime.',
		...createSnapshotDefaults(nowIso()),
		...overrides
	};
}

export function buildBlockingReason(state: StartAccountState): string | undefined {
	const reasons: string[] = [];
	if (state.openOrdersCount > 0) {
		reasons.push(`${state.openOrdersCount} open order${state.openOrdersCount === 1 ? '' : 's'}`);
	}
	if (state.baseAsset > 0.00001) {
		reasons.push(`${round(state.baseAsset, 6)} SUI asset still in margin`);
	}
	if (state.quoteAsset > 0.01) {
		reasons.push(`${round(state.quoteAsset, 6)} USDC asset still in margin`);
	}
	if (state.baseDebt > 0.00001) {
		reasons.push(`${round(state.baseDebt, 6)} SUI debt still open`);
	}
	if (state.quoteDebt > 0.01) {
		reasons.push(`${round(state.quoteDebt, 6)} USDC debt still open`);
	}
	return reasons.length > 0 ? reasons.join(' · ') : undefined;
}

export function managerNeedsCleanup(state: StartAccountState): boolean {
	return Boolean(buildBlockingReason(state));
}

/**
 * Compute the max affordable notional for a single account, considering
 * leverage, auto-swap availability, and safety buffers.
 */
function computeAccountAffordableNotionalUsd(input: {
	accountKey: BotAccountKey;
	usdcAvailable: number;
	suiAvailable: number;
	borrowFactor: number;
	autoSwapEnabled: boolean;
	autoSwapBufferBps: number;
	slippageTolerance: number;
	minGasReserveSui: number;
	referencePrice: number;
}): number {
	const {
		accountKey,
		usdcAvailable,
		suiAvailable,
		borrowFactor,
		autoSwapEnabled,
		autoSwapBufferBps,
		slippageTolerance,
		minGasReserveSui,
		referencePrice
	} = input;
	const factor = Math.max(borrowFactor, 1);
	const bufferMultiplier = 1 + autoSwapBufferBps / 10000;
	const swapSafetyMultiplier = bufferMultiplier + Math.max(slippageTolerance, 0);

	if (accountKey === 'accountA') {
		let effectiveSui = Math.max(suiAvailable - minGasReserveSui, 0);

		if (autoSwapEnabled) {
			const suiFromSwap = usdcAvailable / referencePrice / swapSafetyMultiplier;
			effectiveSui += suiFromSwap;
		}

		return (effectiveSui * factor * referencePrice) / bufferMultiplier;
	}

	let effectiveUsdc = usdcAvailable;
	if (autoSwapEnabled) {
		const availableSuiForSwap = Math.max(suiAvailable - minGasReserveSui, 0);
		const usdcFromSwap = (availableSuiForSwap * referencePrice) / swapSafetyMultiplier;
		effectiveUsdc += usdcFromSwap;
	}

	return (effectiveUsdc * factor) / bufferMultiplier;
}

/**
 * Shared helper: compute effective notional for a cycle given current funding.
 * Used by both preflight and cycle executor to avoid drift.
 */
export function computeEffectiveNotional(input: {
	config: BotConfig;
	balances: RuntimeSnapshot['balances'];
	referencePrice: number;
}): {
	configuredNotionalUsd: number;
	minNotionalUsd: number;
	effectiveNotionalUsd: number;
	autoReduced: boolean;
	belowFloor: boolean;
	autoReducedReason?: string;
} {
	const { config, balances, referencePrice } = input;
	const floorPct = Math.max(1, Math.min(100, config.notional_auto_reduce_floor_pct));
	const configuredNotionalUsd = round(
		config.notional_size_usd * (1 + Math.max(config.random_size_bps, 0) / 10000),
		4
	);
	const minNotionalUsd = round((config.notional_size_usd * floorPct) / 100, 4);

	// If floor is 100%, skip affordability check entirely (legacy behavior)
	if (floorPct >= 100) {
		return {
			configuredNotionalUsd,
			minNotionalUsd: configuredNotionalUsd,
			effectiveNotionalUsd: configuredNotionalUsd,
			autoReduced: false,
			belowFloor: false
		};
	}

	const affordableA = computeAccountAffordableNotionalUsd({
		accountKey: 'accountA',
		usdcAvailable: balances.accountA.usdc,
		suiAvailable: balances.accountA.sui,
		borrowFactor: config.account_a_borrow_quote_factor,
		autoSwapEnabled: config.auto_swap_enabled,
		autoSwapBufferBps: config.auto_swap_buffer_bps,
		slippageTolerance: config.slippage_tolerance,
		minGasReserveSui: config.min_gas_reserve_sui,
		referencePrice
	});
	const affordableB = computeAccountAffordableNotionalUsd({
		accountKey: 'accountB',
		usdcAvailable: balances.accountB.usdc,
		suiAvailable: balances.accountB.sui,
		borrowFactor: config.account_b_borrow_base_factor,
		autoSwapEnabled: config.auto_swap_enabled,
		autoSwapBufferBps: config.auto_swap_buffer_bps,
		slippageTolerance: config.slippage_tolerance,
		minGasReserveSui: config.min_gas_reserve_sui,
		referencePrice
	});

	const maxAffordableNotionalUsd = Math.min(affordableA, affordableB);

	if (maxAffordableNotionalUsd + 1e-4 >= configuredNotionalUsd) {
		return {
			configuredNotionalUsd,
			minNotionalUsd,
			effectiveNotionalUsd: configuredNotionalUsd,
			autoReduced: false,
			belowFloor: false
		};
	}

	// Round down to 0.1 USD step
	const stepped = Math.floor(maxAffordableNotionalUsd * 10) / 10;
	const effectiveNotionalUsd = round(Math.max(stepped, 0), 4);

	if (effectiveNotionalUsd < minNotionalUsd) {
		// Return actual affordable amount (below floor) so caller can block properly
		return {
			configuredNotionalUsd,
			minNotionalUsd,
			effectiveNotionalUsd,
			autoReduced: true,
			belowFloor: true,
			autoReducedReason: `Available funding cannot cover even the minimum size ($${minNotionalUsd.toFixed(2)}).`
		};
	}

	return {
		configuredNotionalUsd,
		minNotionalUsd,
		effectiveNotionalUsd,
		autoReduced: true,
		belowFloor: false,
		autoReducedReason: `Reduced from $${configuredNotionalUsd.toFixed(2)} due to available funding.`
	};
}

export function buildPreflightSnapshot(input: {
	config: BotConfig | null;
	balances: RuntimeSnapshot['balances'];
	referencePrice: number;
	startReadiness?: StartReadinessState;
}): RuntimeSnapshot['preflight'] {
	const { config, balances, referencePrice, startReadiness = createEmptyStartReadiness() } = input;
	const updatedAt = nowIso();
	const empty = createEmptyPreflight();
	empty.updatedAt = updatedAt;
	empty.accountA.updatedAt = updatedAt;
	empty.accountB.updatedAt = updatedAt;

	if (!config) {
		return empty;
	}

	if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
		return {
			...empty,
			state: 'waiting-price'
		};
	}

	const sizing = computeEffectiveNotional({ config, balances, referencePrice });
	const plannedNotionalUsd = sizing.effectiveNotionalUsd;
	const estimatedQuantitySui = round(plannedNotionalUsd / referencePrice, 6);
	const accountARequired = requiredFundingAmount({
		accountKey: 'accountA',
		config,
		plannedNotionalUsd,
		referencePrice
	});
	const accountBRequired = requiredFundingAmount({
		accountKey: 'accountB',
		config,
		plannedNotionalUsd,
		referencePrice
	});
	const accountAAvailable = availableTargetAssetAmount({
		accountKey: 'accountA',
		balance: balances.accountA,
		config
	});
	const accountBAvailable = availableTargetAssetAmount({
		accountKey: 'accountB',
		balance: balances.accountB,
		config
	});
	const accountAMissing = roundAssetAmount(Math.max(accountARequired - accountAAvailable, 0), 'SUI');
	const accountBMissing = roundAssetAmount(Math.max(accountBRequired - accountBAvailable, 0), 'USDC');
	const accountASwapNeeded = estimateSourceSwapAmount({
		accountKey: 'accountA',
		missingTargetAmount: accountAMissing,
		config,
		referencePrice
	});
	const accountBSwapNeeded = estimateSourceSwapAmount({
		accountKey: 'accountB',
		missingTargetAmount: accountBMissing,
		config,
		referencePrice
	});
	const accountAAvailableSwap = availableSwapSourceAmount({
		accountKey: 'accountA',
		balance: balances.accountA,
		config
	});
	const accountBAvailableSwap = availableSwapSourceAmount({
		accountKey: 'accountB',
		balance: balances.accountB,
		config
	});

	const fundingStateA =
		accountAMissing <= 0
			? 'ready'
			: config.auto_swap_enabled && accountAAvailableSwap + 1e-9 >= accountASwapNeeded
				? 'needs-swap'
				: 'deposit-required';
	const fundingStateB =
		accountBMissing <= 0
			? 'ready'
			: config.auto_swap_enabled && accountBAvailableSwap + 1e-9 >= accountBSwapNeeded
				? 'needs-swap'
				: 'deposit-required';
	const accountAState = startReadiness.accountA.isBlocked ? 'reset-required' : fundingStateA;
	const accountBState = startReadiness.accountB.isBlocked ? 'reset-required' : fundingStateB;
	const needsReset = accountAState === 'reset-required' || accountBState === 'reset-required';
	const needsFunding = accountAState === 'deposit-required' || accountBState === 'deposit-required';

	return {
		state: needsReset ? 'needs-reset' : needsFunding ? 'needs-funding' : 'ready',
		ready: !needsReset && !needsFunding,
		referencePrice: round(referencePrice, 6),
		plannedNotionalUsd,
		estimatedQuantitySui,
		configuredNotionalUsd: sizing.configuredNotionalUsd,
		minNotionalUsd: sizing.minNotionalUsd,
		effectiveNotionalUsd: sizing.effectiveNotionalUsd,
		autoReduced: sizing.autoReduced,
		autoReducedReason: sizing.autoReducedReason,
		accountA: {
			account: 'accountA',
			label: config.account_a_label ?? defaultAccountLabel('accountA'),
			requiredAsset: 'SUI',
			requiredAmount: accountARequired,
			availableAmount: accountAAvailable,
			missingAmount: accountAMissing,
			state: accountAState,
			autoSwapEnabled: config.auto_swap_enabled,
			autoSwapAsset: 'USDC',
			autoSwapAmountNeeded: accountAMissing > 0 ? accountASwapNeeded : 0,
			autoSwapAmountAvailable: accountAAvailableSwap,
			managerId: startReadiness.accountA.managerId,
			openOrdersCount: startReadiness.accountA.openOrdersCount,
			baseAsset: startReadiness.accountA.baseAsset,
			quoteAsset: startReadiness.accountA.quoteAsset,
			baseDebt: startReadiness.accountA.baseDebt,
			quoteDebt: startReadiness.accountA.quoteDebt,
			blockingReason: startReadiness.accountA.blockingReason,
			updatedAt
		},
		accountB: {
			account: 'accountB',
			label: config.account_b_label ?? defaultAccountLabel('accountB'),
			requiredAsset: 'USDC',
			requiredAmount: accountBRequired,
			availableAmount: accountBAvailable,
			missingAmount: accountBMissing,
			state: accountBState,
			autoSwapEnabled: config.auto_swap_enabled,
			autoSwapAsset: 'SUI',
			autoSwapAmountNeeded: accountBMissing > 0 ? accountBSwapNeeded : 0,
			autoSwapAmountAvailable: accountBAvailableSwap,
			managerId: startReadiness.accountB.managerId,
			openOrdersCount: startReadiness.accountB.openOrdersCount,
			baseAsset: startReadiness.accountB.baseAsset,
			quoteAsset: startReadiness.accountB.quoteAsset,
			baseDebt: startReadiness.accountB.baseDebt,
			quoteDebt: startReadiness.accountB.quoteDebt,
			blockingReason: startReadiness.accountB.blockingReason,
			updatedAt
		},
		updatedAt
	};
}

export function buildBalancesAndPreflightSnapshotUpdate(input: {
	snapshot: RuntimeSnapshot;
	config: BotConfig | null;
	balances: RuntimeSnapshot['balances'];
	referencePrice: number;
	startReadiness?: StartReadinessState;
}): Pick<RuntimeSnapshot, 'balances' | 'preflight'> {
	return {
		balances: input.balances,
		preflight: buildPreflightSnapshot({
			config: input.config,
			balances: input.balances,
			referencePrice: input.referencePrice,
			startReadiness: input.startReadiness
		})
	};
}

export function estimateAutoBalanceReservePerExtraCycleUsdc(input: {
	config: BotConfig;
	plannedNotionalUsd: number;
	perCycleUsdc: number;
	recentCycles?: CycleHistoryRecord[];
}): number {
	const { plannedNotionalUsd, perCycleUsdc, recentCycles = [] } = input;
	const fallbackFloor = round(Math.max(0.25, plannedNotionalUsd * 0.0025), 6);
	const cap = round(Math.max(perCycleUsdc * 0.15, fallbackFloor), 6);
	const completedCycles = recentCycles.filter((cycle) => cycle.status === 'completed');
	const realizedLosses = completedCycles
		.map((cycle) => (Number.isFinite(cycle.pnlUsd) ? Math.max(-cycle.pnlUsd, 0) : 0))
		.filter((loss) => loss > 0);
	const observedLossPerCycle =
		realizedLosses.length > 0
			? round(realizedLosses.reduce((sum, loss) => sum + loss, 0) / realizedLosses.length, 6)
			: 0;

	return round(Math.min(Math.max(observedLossPerCycle, fallbackFloor), cap), 6);
}

export function buildAutoBalanceAccountPreview(input: {
	accountKey: BotAccountKey;
	label: string;
	config: BotConfig;
	balances: RuntimeSnapshot['balances'];
	referencePrice: number;
	targetCycles: number;
	reservePerExtraCycleUsdc: number;
	isBlocked: boolean;
	blockingReason?: string;
}): AutoBalanceAccountPreview {
	const {
		accountKey,
		label,
		config,
		balances,
		referencePrice,
		targetCycles,
		reservePerExtraCycleUsdc,
		isBlocked,
		blockingReason
	} = input;
	const bal = balances[accountKey];
	const targetAsset = accountTargetAsset(accountKey);
	const sourceAsset = accountSwapSourceAsset(accountKey);

	if (isBlocked) {
		return {
			account: accountKey,
			label,
			targetAsset,
			sourceAsset,
			workingCapitalAmount: 0,
			reserveAmount: 0,
			reservePerExtraCycleUsd: 0,
			targetAmount: 0,
			currentAmount: availableTargetAssetAmount({ accountKey, balance: bal, config }),
			shortfallAmount: 0,
			estimatedSourceAmount: 0,
			availableSourceAmount: 0,
			state: 'blocked',
			reason: blockingReason ?? 'Manager needs cleanup before balancing.'
		};
	}

	const plannedNotionalUsd = round(
		config.notional_size_usd * (1 + Math.max(config.random_size_bps, 0) / 10000),
		4
	);
	const workingCapitalAmount = requiredFundingAmount({
		accountKey,
		config,
		plannedNotionalUsd,
		referencePrice
	});
	const reserveUsd = round(reservePerExtraCycleUsdc * Math.max(targetCycles - 1, 0), 6);
	const reserveAmount =
		targetAsset === 'SUI'
			? roundAssetAmount(reserveUsd / referencePrice, 'SUI')
			: roundAssetAmount(reserveUsd, 'USDC');
	const targetAmount = roundAssetAmount(workingCapitalAmount + reserveAmount, targetAsset);
	const currentAmount = availableTargetAssetAmount({ accountKey, balance: bal, config });

	if (currentAmount + 1e-9 >= targetAmount) {
		return {
			account: accountKey,
			label,
			targetAsset,
			sourceAsset,
			workingCapitalAmount,
			reserveAmount,
			reservePerExtraCycleUsd: reservePerExtraCycleUsdc,
			targetAmount,
			currentAmount,
			shortfallAmount: 0,
			estimatedSourceAmount: 0,
			availableSourceAmount: availableSwapSourceAmount({ accountKey, balance: bal, config }),
			state: 'ready'
		};
	}

	const shortfallAmount = roundAssetAmount(targetAmount - currentAmount, targetAsset);
	const estimatedSourceAmount = estimateSourceSwapAmount({
		accountKey,
		missingTargetAmount: shortfallAmount,
		config,
		referencePrice
	});
	const availableSourceAmount = availableSwapSourceAmount({ accountKey, balance: bal, config });

	if (availableSourceAmount + 1e-9 < estimatedSourceAmount) {
		return {
			account: accountKey,
			label,
			targetAsset,
			sourceAsset,
			workingCapitalAmount,
			reserveAmount,
			reservePerExtraCycleUsd: reservePerExtraCycleUsdc,
			targetAmount,
			currentAmount,
			shortfallAmount,
			estimatedSourceAmount,
			availableSourceAmount,
			state: 'insufficient-source-asset',
			reason:
				sourceAsset === 'SUI'
					? `Need ~${estimatedSourceAmount.toFixed(4)} ${sourceAsset} but only ${availableSourceAmount.toFixed(4)} available after gas reserve.`
					: `Need ~${estimatedSourceAmount.toFixed(4)} ${sourceAsset} but only ${availableSourceAmount.toFixed(4)} available in wallet.`
		};
	}

	return {
		account: accountKey,
		label,
		targetAsset,
		sourceAsset,
		workingCapitalAmount,
		reserveAmount,
		reservePerExtraCycleUsd: reservePerExtraCycleUsdc,
		targetAmount,
		currentAmount,
		shortfallAmount,
		estimatedSourceAmount,
		availableSourceAmount,
		state: 'planned'
	};
}

export function buildAutoBalancePreview(input: {
	config: BotConfig;
	balances: RuntimeSnapshot['balances'];
	referencePrice: number;
	targetCycles: number;
	startReadiness: StartReadinessState;
	accountALabel: string;
	accountBLabel: string;
	recentCycles?: CycleHistoryRecord[];
}): AutoBalancePreview {
	const {
		config,
		balances,
		referencePrice,
		targetCycles,
		startReadiness,
		accountALabel,
		accountBLabel,
		recentCycles = []
	} = input;
	const plannedNotionalUsd = round(
		config.notional_size_usd * (1 + Math.max(config.random_size_bps, 0) / 10000),
		4
	);
	const reservePerExtraCycleUsdc = estimateAutoBalanceReservePerExtraCycleUsdc({
		config,
		plannedNotionalUsd,
		perCycleUsdc: Math.max(
			plannedNotionalUsd / Math.max(config.account_a_borrow_quote_factor, 1),
			plannedNotionalUsd / Math.max(config.account_b_borrow_base_factor, 1)
		),
		recentCycles
	});
	const minShareTransferUsdc = 0.5;
	const minShareTransferSui = 0.0001;
	const computeAccounts = (candidateBalances: RuntimeSnapshot['balances']) => ({
		accountA: buildAutoBalanceAccountPreview({
			accountKey: 'accountA',
			label: accountALabel,
			config,
			balances: candidateBalances,
			referencePrice,
			targetCycles,
			reservePerExtraCycleUsdc,
			isBlocked: startReadiness.accountA.isBlocked,
			blockingReason: startReadiness.accountA.blockingReason
		}),
		accountB: buildAutoBalanceAccountPreview({
			accountKey: 'accountB',
			label: accountBLabel,
			config,
			balances: candidateBalances,
			referencePrice,
			targetCycles,
			reservePerExtraCycleUsdc,
			isBlocked: startReadiness.accountB.isBlocked,
			blockingReason: startReadiness.accountB.blockingReason
		})
	});
	const canExecuteFromAccounts = (
		accountA: AutoBalanceAccountPreview,
		accountB: AutoBalanceAccountPreview
	): boolean =>
		(accountA.state === 'planned' || accountA.state === 'ready') &&
		(accountB.state === 'planned' || accountB.state === 'ready');
	const simulateShareTransfer = (
		from: BotAccountKey,
		to: BotAccountKey,
		asset: 'USDC' | 'SUI',
		amount: number
	): {
		accountA: AutoBalanceAccountPreview;
		accountB: AutoBalanceAccountPreview;
		canExecute: boolean;
	} => {
		const candidateBalances: RuntimeSnapshot['balances'] = {
			...balances,
			accountA: { ...balances.accountA },
			accountB: { ...balances.accountB }
		};
		if (asset === 'USDC') {
			candidateBalances[from].usdc = roundAssetAmount(
				Math.max(candidateBalances[from].usdc - amount, 0),
				'USDC'
			);
			candidateBalances[to].usdc = roundAssetAmount(candidateBalances[to].usdc + amount, 'USDC');
		} else {
			candidateBalances[from].sui = roundAssetAmount(
				Math.max(candidateBalances[from].sui - amount, 0),
				'SUI'
			);
			candidateBalances[to].sui = roundAssetAmount(candidateBalances[to].sui + amount, 'SUI');
		}
		candidateBalances.accountA.totalUsdc = round(
			candidateBalances.accountA.usdc + candidateBalances.accountA.sui * referencePrice,
			6
		);
		candidateBalances.accountB.totalUsdc = round(
			candidateBalances.accountB.usdc + candidateBalances.accountB.sui * referencePrice,
			6
		);
		candidateBalances.totalUsdc = round(
			candidateBalances.accountA.totalUsdc + candidateBalances.accountB.totalUsdc,
			6
		);
		const computed = computeAccounts(candidateBalances);
		return {
			...computed,
			canExecute: canExecuteFromAccounts(computed.accountA, computed.accountB)
		};
	};

	let { accountA, accountB } = computeAccounts(balances);
	let canExecute = canExecuteFromAccounts(accountA, accountB);
	let shareTransfer: AutoBalancePreview['shareTransfer'] = null;

	if (!canExecute && accountB.state === 'insufficient-source-asset' && accountB.shortfallAmount > 0) {
		const accountAUsdcNeeded =
			accountA.state === 'planned' || accountA.state === 'insufficient-source-asset'
				? accountA.estimatedSourceAmount
				: 0;
		const accountASpareUsdc = roundAssetAmount(
			Math.max(balances.accountA.usdc - accountAUsdcNeeded, 0),
			'USDC'
		);
		const transferAmount = roundAssetAmount(
			Math.min(accountB.shortfallAmount, accountASpareUsdc),
			'USDC'
		);
		if (transferAmount + 1e-9 >= minShareTransferUsdc) {
			const candidate = simulateShareTransfer('accountA', 'accountB', 'USDC', transferAmount);
			if (candidate.canExecute) {
				accountA = candidate.accountA;
				accountB = candidate.accountB;
				canExecute = true;
				shareTransfer = {
					from: 'accountA',
					to: 'accountB',
					asset: 'USDC',
					amount: transferAmount
				};
			}
		}
		if (!canExecute) {
			const accountATargetSuiNeeded =
				accountA.targetAmount + (accountA.targetAsset === 'SUI' ? config.min_gas_reserve_sui : 0);
			const accountASpareSui = roundAssetAmount(
				Math.max(balances.accountA.sui - accountATargetSuiNeeded, 0),
				'SUI'
			);
			const accountBSourceShortfall = roundAssetAmount(
				Math.max(accountB.estimatedSourceAmount - accountB.availableSourceAmount, 0),
				'SUI'
			);
			const transferSuiAmount = roundAssetAmount(
				Math.min(accountBSourceShortfall, accountASpareSui),
				'SUI'
			);
			if (transferSuiAmount + 1e-12 >= minShareTransferSui) {
				const candidate = simulateShareTransfer(
					'accountA',
					'accountB',
					'SUI',
					transferSuiAmount
				);
				if (candidate.canExecute) {
					accountA = candidate.accountA;
					accountB = candidate.accountB;
					canExecute = true;
					shareTransfer = {
						from: 'accountA',
						to: 'accountB',
						asset: 'SUI',
						amount: transferSuiAmount
					};
				}
			}
		}
	}

	if (!canExecute && accountA.state === 'insufficient-source-asset') {
		const accountBUsdcNeeded = accountB.targetAmount;
		const accountBSpareUsdc = roundAssetAmount(
			Math.max(balances.accountB.usdc - accountBUsdcNeeded, 0),
			'USDC'
		);
		const accountASourceShortfall = roundAssetAmount(
			Math.max(accountA.estimatedSourceAmount - accountA.availableSourceAmount, 0),
			'USDC'
		);
		const transferAmount = roundAssetAmount(
			Math.min(accountASourceShortfall, accountBSpareUsdc),
			'USDC'
		);
		if (transferAmount + 1e-9 >= minShareTransferUsdc) {
			const candidate = simulateShareTransfer('accountB', 'accountA', 'USDC', transferAmount);
			if (candidate.canExecute) {
				accountA = candidate.accountA;
				accountB = candidate.accountB;
				canExecute = true;
				shareTransfer = {
					from: 'accountB',
					to: 'accountA',
					asset: 'USDC',
					amount: transferAmount
				};
			}
		}
		if (!canExecute) {
			const accountBSourceSuiNeeded =
				accountB.state === 'planned' || accountB.state === 'insufficient-source-asset'
					? accountB.estimatedSourceAmount
					: 0;
			const accountBSpareSui = roundAssetAmount(
				Math.max(
					balances.accountB.sui - config.min_gas_reserve_sui - accountBSourceSuiNeeded,
					0
				),
				'SUI'
			);
			const transferSuiAmount = roundAssetAmount(
				Math.min(accountA.shortfallAmount, accountBSpareSui),
				'SUI'
			);
			if (transferSuiAmount + 1e-12 >= minShareTransferSui) {
				const candidate = simulateShareTransfer(
					'accountB',
					'accountA',
					'SUI',
					transferSuiAmount
				);
				if (candidate.canExecute) {
					accountA = candidate.accountA;
					accountB = candidate.accountB;
					canExecute = true;
					shareTransfer = {
						from: 'accountB',
						to: 'accountA',
						asset: 'SUI',
						amount: transferSuiAmount
					};
				}
			}
		}
	}

	const anyPlanned = accountA.state === 'planned' || accountB.state === 'planned';
	let message: string;
	if (!canExecute) {
		const reasons: string[] = [];
		if (accountA.state === 'blocked') reasons.push(`Account A: ${accountA.reason}`);
		if (accountB.state === 'blocked') reasons.push(`Account B: ${accountB.reason}`);
		if (accountA.state === 'insufficient-source-asset') {
			reasons.push(`Account A: not enough ${accountA.sourceAsset} for swap.`);
		}
		if (accountB.state === 'insufficient-source-asset') {
			reasons.push(`Account B: not enough ${accountB.sourceAsset} for swap.`);
		}
		message = reasons.join(' ');
	} else if (shareTransfer) {
		message = `Ready to prepare funding. Wallets will share ${shareTransfer.asset} before swaps to satisfy cycle funding targets.`;
	} else if (!anyPlanned) {
		message =
			'Both accounts already meet the estimated target assets. This target uses one-cycle working capital plus a reserve buffer, not cumulative spend.';
	} else {
		message =
			'Ready to prepare funding. Targets use one-cycle working capital plus a reserve buffer, not cumulative spend across cycles.';
	}

	return {
		targetCycles,
		referencePrice,
		accountA,
		accountB,
		shareTransfer,
		canExecute,
		message
	};
}

export type PostCycleFundingTransferPlan = {
	from: BotAccountKey;
	to: BotAccountKey;
	amountUsdc: number;
};

export type PostCycleFundingSwapPlan = {
	account: BotAccountKey;
	targetAsset: 'SUI' | 'USDC';
	sourceAsset: 'SUI' | 'USDC';
	targetAmount: number;
	currentAmount: number;
	shortfallAmount: number;
	estimatedSourceAmount: number;
	availableSourceAmount: number;
};

export type PostCycleFundingMaintenancePlan = {
	blockedAccounts: BotAccountKey[];
	transfer: PostCycleFundingTransferPlan | null;
	swaps: PostCycleFundingSwapPlan[];
};

export function buildPostCycleFundingMaintenancePlan(input: {
	config: BotConfig;
	balances: RuntimeSnapshot['balances'];
	preview: AutoBalancePreview;
	minTransferUsdc: number;
	minSwapShortfallUsdc: number;
	minSwapSuiIn: number;
}): PostCycleFundingMaintenancePlan {
	const {
		config,
		balances,
		preview,
		minTransferUsdc,
		minSwapShortfallUsdc,
		minSwapSuiIn
	} = input;
	const blockedAccounts: BotAccountKey[] = [];
	if (preview.accountA.state === 'blocked') {
		blockedAccounts.push('accountA');
	}
	if (preview.accountB.state === 'blocked') {
		blockedAccounts.push('accountB');
	}
	if (blockedAccounts.length > 0) {
		return {
			blockedAccounts,
			transfer: null,
			swaps: []
		};
	}
	const referencePrice = preview.referencePrice;
	const swaps: PostCycleFundingSwapPlan[] = [];

	for (const account of ['accountA', 'accountB'] as BotAccountKey[]) {
		const accountPreview = account === 'accountA' ? preview.accountA : preview.accountB;
		const shortfallAmount = round(
			Math.max(accountPreview.targetAmount - accountPreview.currentAmount, 0),
			accountPreview.targetAsset === 'SUI' ? 9 : 6
		);
		const shortfallUsd =
			accountPreview.targetAsset === 'SUI'
				? round(shortfallAmount * referencePrice, 6)
				: round(shortfallAmount, 6);
		if (shortfallUsd + 1e-9 < minSwapShortfallUsdc) {
			continue;
		}
		if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
			continue;
		}

		const estimatedSourceAmount = estimateSourceSwapAmount({
			accountKey: account,
			missingTargetAmount: shortfallAmount,
			config,
			referencePrice
		});
		if (
			(accountPreview.sourceAsset === 'SUI' && estimatedSourceAmount + 1e-12 < minSwapSuiIn) ||
			(accountPreview.sourceAsset === 'USDC' && estimatedSourceAmount + 1e-9 < minTransferUsdc)
		) {
			continue;
		}

		const availableSourceAmount = availableSwapSourceAmount({
			accountKey: account,
			balance: balances[account],
			config
		});

		swaps.push({
			account,
			targetAsset: accountPreview.targetAsset,
			sourceAsset: accountPreview.sourceAsset,
			targetAmount: accountPreview.targetAmount,
			currentAmount: accountPreview.currentAmount,
			shortfallAmount,
			estimatedSourceAmount,
			availableSourceAmount
		});
	}

	return {
		blockedAccounts,
		transfer: null,
		swaps
	};
}
