import { describe, expect, it } from 'vitest';

import {
	buildAutoBalanceAccountPreview,
	buildAutoBalancePreview,
	buildBlockingReason,
	buildPostCycleFundingMaintenancePlan,
	buildPreflightSnapshot,
	computeEffectiveNotional,
	computeMaxAffordableNotional,
	createEmptyBalances,
	createEmptyStartReadiness,
	estimateAutoBalanceReservePerExtraCycleUsdc,
	managerNeedsCleanup
} from './runtime-snapshot.js';
import type { BotConfig } from './types.js';

function createConfig(): BotConfig {
	return {
		network: 'mainnet',
		rpc_url: 'http://localhost:9000',
		rpc_urls: ['http://localhost:9000'],
		experimental_deeptrade_limit_ptb: false,
		deeptrade_orderbook_api_base: 'http://localhost:8080',
		pool_key: 'SUI_USDC',
		account_a_label: 'Account A',
		account_b_label: 'Account B',
		private_key_A: 'a',
		private_key_B: 'b',
		notional_size_usd: 100,
		min_hold_seconds: 1,
		max_hold_seconds: 2,
		max_cycles: null,
		slippage_tolerance: 0.01,
		order_poll_interval_ms: 100,
		maker_reprice_seconds: 1,
		force_market_close_seconds: 1,
		random_size_bps: 1000,
		min_order_delay_ms: 0,
		max_order_delay_ms: 0,
		open_order_execution_mode: 'limit',
		close_order_execution_mode: 'limit',
		auto_swap_enabled: true,
		auto_swap_buffer_bps: 500,
		min_gas_reserve_sui: 1,
		account_a_borrow_quote_factor: 1,
		account_b_borrow_base_factor: 1,
		notional_auto_reduce_floor_pct: 100
	};
}

describe('runtime-snapshot', () => {
	it('derives preflight funding and reset state', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 0.5;
		balances.accountA.sui = 13;
		balances.accountB.usdc = 20;
		balances.accountB.sui = 20;

		const readiness = createEmptyStartReadiness();
		readiness.accountB.isBlocked = true;
		readiness.accountB.blockingReason = '1 open order';

		const snapshot = buildPreflightSnapshot({
			config: createConfig(),
			balances,
			referencePrice: 10,
			startReadiness: readiness
		});

		expect(snapshot.accountA.state).toBe('ready');
		expect(snapshot.accountB.state).toBe('reset-required');
		expect(snapshot.state).toBe('needs-reset');
		expect(snapshot.ready).toBe(false);
	});

	it('builds blocking reasons and cleanup-needed state from manager balances', () => {
		const state = {
			managerId: '0x123',
			openOrdersCount: 1,
			baseAsset: 0.5,
			quoteAsset: 2,
			baseDebt: 0,
			quoteDebt: 0,
			isBlocked: true
		};

		const reason = buildBlockingReason(state);
		expect(reason).toContain('1 open order');
		expect(reason).toContain('0.5 SUI asset still in margin');
		expect(managerNeedsCleanup(state)).toBe(true);
	});

	it('returns waiting-price when live price is unavailable', () => {
		const snapshot = buildPreflightSnapshot({
			config: createConfig(),
			balances: createEmptyBalances(),
			referencePrice: 0
		});

		expect(snapshot.state).toBe('waiting-price');
		expect(snapshot.ready).toBe(false);
	});
});

describe('auto-balance preview', () => {
	it('returns planned when each account can swap into its own target asset', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 150;
		balances.accountA.sui = 1.2;
		balances.accountB.usdc = 10;
		balances.accountB.sui = 50;

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.state).toBe('planned');
		expect(result.accountB.state).toBe('planned');
		expect(result.canExecute).toBe(true);
		expect(result.accountA.targetAsset).toBe('SUI');
		expect(result.accountA.sourceAsset).toBe('USDC');
		expect(result.accountB.targetAsset).toBe('USDC');
		expect(result.accountB.sourceAsset).toBe('SUI');
		expect(result.accountA.shortfallAmount).toBeGreaterThan(0);
		expect(result.accountB.shortfallAmount).toBeGreaterThan(0);
		expect(result.accountA.estimatedSourceAmount).toBeGreaterThan(0);
		expect(result.message).toContain('one-cycle working capital plus a reserve buffer');
	});

	it('returns ready when both accounts already meet target assets', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 10;
		balances.accountA.sui = 20;
		balances.accountB.usdc = 500;
		balances.accountB.sui = 10;

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.state).toBe('ready');
		expect(result.accountB.state).toBe('ready');
		expect(result.canExecute).toBe(true);
		expect(result.accountA.shortfallAmount).toBe(0);
		expect(result.accountB.shortfallAmount).toBe(0);
		expect(result.message).toContain('Both accounts already meet the estimated target assets');
	});

	it('returns blocked when cleanup is required', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 10;
		balances.accountA.sui = 50;
		balances.accountB.usdc = 10;
		balances.accountB.sui = 50;

		const readiness = createEmptyStartReadiness();
		readiness.accountA.isBlocked = true;
		readiness.accountA.blockingReason = '1 open order';

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: readiness,
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.state).toBe('blocked');
		expect(result.canExecute).toBe(false);
		expect(result.message).toContain('Account A');
	});

	it('returns insufficient-source-asset when swap cannot be funded', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 1;
		balances.accountA.sui = 1.5;
		balances.accountB.usdc = 0;
		balances.accountB.sui = 1.1;

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.state).toBe('insufficient-source-asset');
		expect(result.accountA.reason).toContain('USDC');
		expect(result.canExecute).toBe(false);
		expect(result.message).toContain('Account A: not enough USDC for swap.');
	});

	it('plans a USDC share transfer when that makes funding executable', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 150;
		balances.accountA.sui = 30;
		balances.accountB.usdc = 20;
		balances.accountB.sui = 0.2;

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.canExecute).toBe(true);
		expect(result.shareTransfer).toEqual(
			expect.objectContaining({
				from: 'accountA',
				to: 'accountB',
				asset: 'USDC'
			})
		);
		expect(result.accountA.state).toBe('ready');
		expect(result.accountB.state).toBe('ready');
		expect(result.message).toContain('share USDC');
	});

	it('plans a SUI share transfer when account A needs target SUI and account B has spare SUI', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 1;
		balances.accountA.sui = 1.2;
		balances.accountB.usdc = 0;
		balances.accountB.sui = 40;

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.canExecute).toBe(true);
		expect(result.shareTransfer).toEqual(
			expect.objectContaining({
				from: 'accountB',
				to: 'accountA',
				asset: 'SUI'
			})
		);
		expect(result.accountA.state).toBe('ready');
		expect(result.accountB.state).toBe('planned');
		expect(result.message).toContain('share SUI');
	});

	it('handles one-account deficit and one-account ready', () => {
		const balances = createEmptyBalances();
		balances.accountA.usdc = 10;
		balances.accountA.sui = 20;
		balances.accountB.usdc = 10;
		balances.accountB.sui = 50;

		const result = buildAutoBalancePreview({
			config: createConfig(),
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.state).toBe('ready');
		expect(result.accountB.state).toBe('planned');
		expect(result.canExecute).toBe(true);
		expect(result.message).toContain('one-cycle working capital plus a reserve buffer');
	});

	it('never plans a swap when target assets exceed the target by a tiny margin', () => {
		const config = createConfig();
		const base = buildAutoBalancePreview({
			config,
			balances: createEmptyBalances(),
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});
		const balances = createEmptyBalances();
		balances.accountA.sui = base.accountA.targetAmount + config.min_gas_reserve_sui + 0.001;
		balances.accountB.usdc = base.accountB.targetAmount + 0.001;
		balances.accountB.sui = 10;

		const result = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.state).toBe('ready');
		expect(result.accountB.state).toBe('ready');
		expect(result.accountA.estimatedSourceAmount).toBe(0);
		expect(result.accountB.estimatedSourceAmount).toBe(0);
	});

	it('per-account preview uses correct borrow factor for each account', () => {
		const config = createConfig();
		config.account_a_borrow_quote_factor = 2;
		config.account_b_borrow_base_factor = 3;

		const balances = createEmptyBalances();
		balances.accountA.usdc = 100;
		balances.accountA.sui = 1;
		balances.accountB.usdc = 0;
		balances.accountB.sui = 100;

		const result = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 1,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.targetAsset).toBe('SUI');
		expect(result.accountB.targetAsset).toBe('USDC');
		expect(result.accountA.targetAmount * 10).toBeGreaterThan(result.accountB.targetAmount);
		expect(result.accountA.state).toBe('planned');
		expect(result.accountB.state).toBe('planned');
	});

	it('uses one-cycle working capital plus reserve instead of multiplying full collateral by target cycles', () => {
		const config = createConfig();
		const balances = createEmptyBalances();
		const result = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 5,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		expect(result.accountA.targetAmount).toBeLessThan(result.accountA.workingCapitalAmount * 5);
		expect(result.accountA.reserveAmount).toBeGreaterThan(0);
		expect(result.accountA.targetAmount).toBeCloseTo(
			result.accountA.workingCapitalAmount + result.accountA.reserveAmount,
			6
		);
	});

	it('buildAutoBalanceAccountPreview returns blocked with custom reason', () => {
		const config = createConfig();
		const balances = createEmptyBalances();
		balances.accountA.usdc = 50;
		balances.accountA.sui = 10;

		const preview = buildAutoBalanceAccountPreview({
			accountKey: 'accountA',
			label: 'Account A',
			config,
			balances,
			referencePrice: 10,
			targetCycles: 2,
			reservePerExtraCycleUsdc: 0.25,
			isBlocked: true,
			blockingReason: 'debt still open'
		});

		expect(preview.state).toBe('blocked');
		expect(preview.reason).toBe('debt still open');
		expect(preview.targetAmount).toBe(0);
		expect(preview.workingCapitalAmount).toBe(0);
	});

	it('returns belowFloor with the actual affordable notional when funding cannot reach the floor', () => {
		const config = createConfig();
		config.notional_size_usd = 30;
		config.random_size_bps = 0;
		config.auto_swap_buffer_bps = 0;
		config.slippage_tolerance = 0;
		config.min_gas_reserve_sui = 0;
		config.notional_auto_reduce_floor_pct = 70;

		const balances = createEmptyBalances();
		balances.accountA.usdc = 12;
		balances.accountB.usdc = 15;

		const result = computeEffectiveNotional({
			config,
			balances,
			referencePrice: 1
		});

		expect(result.belowFloor).toBe(true);
		expect(result.minNotionalUsd).toBe(21);
		expect(result.effectiveNotionalUsd).toBe(12);
	});

	it('computes max affordable notional and limiting account', () => {
		const config = createConfig();
		config.random_size_bps = 0;
		config.auto_swap_buffer_bps = 0;
		config.slippage_tolerance = 0;
		config.min_gas_reserve_sui = 0;
		config.account_a_borrow_quote_factor = 1;
		config.account_b_borrow_base_factor = 1;

		const balances = createEmptyBalances();
		balances.accountA.usdc = 60;
		balances.accountB.usdc = 100;

		const result = computeMaxAffordableNotional({
			config,
			balances,
			referencePrice: 1
		});

		expect(result.accountACeilingUsd).toBe(60);
		expect(result.accountBCeilingUsd).toBe(100);
		expect(result.maxAffordableNotionalUsd).toBe(60);
		expect(result.limitingAccount).toBe('accountA');
	});

	it('marks both as limiting when account ceilings are effectively equal', () => {
		const config = createConfig();
		config.random_size_bps = 0;
		config.auto_swap_buffer_bps = 0;
		config.slippage_tolerance = 0;
		config.min_gas_reserve_sui = 0;
		config.account_a_borrow_quote_factor = 1;
		config.account_b_borrow_base_factor = 1;

		const balances = createEmptyBalances();
		balances.accountA.usdc = 80;
		balances.accountB.usdc = 80;

		const result = computeMaxAffordableNotional({
			config,
			balances,
			referencePrice: 1
		});

		expect(result.maxAffordableNotionalUsd).toBe(80);
		expect(result.limitingAccount).toBe('both');
	});
});

describe('post-cycle funding maintenance planning', () => {
	it('returns no actions when both accounts are already balanced', () => {
		const config = createConfig();
		const balances = createEmptyBalances();
		balances.accountA.usdc = 10;
		balances.accountA.sui = 20;
		balances.accountB.usdc = 500;
		balances.accountB.sui = 20;

		const preview = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});
		const plan = buildPostCycleFundingMaintenancePlan({
			config,
			balances,
			preview,
			minTransferUsdc: 0.5,
			minSwapShortfallUsdc: 0.5,
			minSwapSuiIn: 0.0001
		});

		expect(plan.blockedAccounts).toEqual([]);
		expect(plan.transfer).toBeNull();
		expect(plan.swaps).toEqual([]);
	});

	it('plans a local USDC -> SUI swap for Account A without cross-account sharing', () => {
		const config = createConfig();
		const balances = createEmptyBalances();
		balances.accountA.usdc = 150;
		balances.accountA.sui = 1.2;
		balances.accountB.usdc = 500;
		balances.accountB.sui = 20;

		const preview = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});
		const plan = buildPostCycleFundingMaintenancePlan({
			config,
			balances,
			preview,
			minTransferUsdc: 0.5,
			minSwapShortfallUsdc: 0.5,
			minSwapSuiIn: 0.0001
		});

		expect(plan.transfer).toBeNull();
		expect(plan.swaps).toEqual([
			expect.objectContaining({
				account: 'accountA',
				targetAsset: 'SUI',
				sourceAsset: 'USDC'
			})
		]);
	});

	it('plans local swaps independently for both accounts', () => {
		const config = createConfig();
		const balances = createEmptyBalances();
		balances.accountA.usdc = 150;
		balances.accountA.sui = 1.2;
		balances.accountB.usdc = 10;
		balances.accountB.sui = 50;

		const preview = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});
		const plan = buildPostCycleFundingMaintenancePlan({
			config,
			balances,
			preview,
			minTransferUsdc: 0.5,
			minSwapShortfallUsdc: 0.5,
			minSwapSuiIn: 0.0001
		});

		expect(plan.transfer).toBeNull();
		expect(plan.swaps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					account: 'accountA',
					targetAsset: 'SUI',
					sourceAsset: 'USDC'
				}),
				expect.objectContaining({
					account: 'accountB',
					targetAsset: 'USDC',
					sourceAsset: 'SUI'
				})
			])
		);
	});

	it('skips dust transfer/swap actions below threshold', () => {
		const config = createConfig();
		const baseBalances = createEmptyBalances();
		baseBalances.accountA.usdc = 100;
		baseBalances.accountA.sui = 10;
		baseBalances.accountB.usdc = 0;
		baseBalances.accountB.sui = 10;
		const basePreview = buildAutoBalancePreview({
			config,
			balances: baseBalances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});

		const balances = createEmptyBalances();
		balances.accountA.usdc = 100;
		balances.accountA.sui =
			basePreview.accountA.targetAmount - 0.01 + config.min_gas_reserve_sui;
		balances.accountB.sui = 10;
		balances.accountB.usdc = basePreview.accountB.targetAmount - 0.2;

		const preview = buildAutoBalancePreview({
			config,
			balances,
			referencePrice: 10,
			targetCycles: 2,
			startReadiness: createEmptyStartReadiness(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B'
		});
		const plan = buildPostCycleFundingMaintenancePlan({
			config,
			balances,
			preview,
			minTransferUsdc: 0.5,
			minSwapShortfallUsdc: 0.5,
			minSwapSuiIn: 0.0001
		});

		expect(plan.transfer).toBeNull();
		expect(plan.swaps).toEqual([]);
	});
});
