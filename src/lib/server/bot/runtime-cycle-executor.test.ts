import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeCycleExecutor } from './runtime-cycle-executor.js';
import type { ManagedAccount, RuntimeCycleContext } from './runtime-context.js';
import type { BotConfig, RuntimeSnapshot } from './types.js';

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
		order_poll_interval_ms: 0,
		maker_reprice_seconds: 0,
		force_market_close_seconds: 1,
		random_size_bps: 0,
		min_order_delay_ms: 0,
		max_order_delay_ms: 0,
		open_order_execution_mode: 'limit',
		close_order_execution_mode: 'limit',
		auto_swap_enabled: false,
		auto_swap_buffer_bps: 0,
		min_gas_reserve_sui: 1,
		account_a_borrow_quote_factor: 1,
		account_b_borrow_base_factor: 1,
		notional_auto_reduce_floor_pct: 100
	};
}

function createManagedAccount(key: 'accountA' | 'accountB'): ManagedAccount {
	return {
		key,
		label: key === 'accountA' ? 'Account A' : 'Account B',
		address: `0x${key}`,
		marginManagerId: `manager-${key}`,
		signer: {} as never
	};
}

function createContext(
	service: Record<string, unknown>,
	configOverrides: Partial<BotConfig> = {},
	dbOverrides: Record<string, unknown> = {}
) {
	const logs: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
	let currentCycleAuxiliaryGasUsd = 0;
	const currentCycleOrders: RuntimeCycleContext['getCurrentCycleOrders'] extends () => infer T
		? T
		: never = [];
	const snapshot: RuntimeSnapshot = {
		lifecycle: 'RUNNING',
		liveLabel: 'Live',
		runLabel: 'RUNNING',
		message: 'running',
		stats: {
			totalVolumeAllTime: 0,
			totalVolumeToday: 0,
			totalVolumeAccountA: 0,
			totalVolumeAccountB: 0,
			sessionPnl: 0,
			sessionFees: 0,
			sessionGas: 0,
			cyclesCompleted: 0,
			updatedAt: new Date().toISOString()
		},
		price: {
			source: 'static',
			price: 10,
			updatedAt: new Date().toISOString(),
			uptimeSeconds: 0
		},
		balances: {
			source: 'static',
			accountA: { sui: 0, usdc: 0, totalUsdc: 0, updatedAt: new Date().toISOString() },
			accountB: { sui: 0, usdc: 0, totalUsdc: 0, updatedAt: new Date().toISOString() },
			totalUsdc: 0,
			updatedAt: new Date().toISOString()
		},
		preflight: {
			state: 'ready',
			ready: true,
			referencePrice: 10,
			plannedNotionalUsd: 100,
			estimatedQuantitySui: 10,
			configuredNotionalUsd: 100,
			minNotionalUsd: 100,
			effectiveNotionalUsd: 100,
			autoReduced: false,
			accountA: {
				account: 'accountA',
				label: 'Account A',
				requiredAsset: 'SUI',
				requiredAmount: 0,
				availableAmount: 0,
				missingAmount: 0,
				state: 'ready',
				autoSwapEnabled: false,
				openOrdersCount: 0,
				baseAsset: 0,
				quoteAsset: 0,
				baseDebt: 0,
				quoteDebt: 0,
				updatedAt: new Date().toISOString()
			},
			accountB: {
				account: 'accountB',
				label: 'Account B',
				requiredAsset: 'USDC',
				requiredAmount: 0,
				availableAmount: 0,
				missingAmount: 0,
				state: 'ready',
				autoSwapEnabled: false,
				openOrdersCount: 0,
				baseAsset: 0,
				quoteAsset: 0,
				baseDebt: 0,
				quoteDebt: 0,
				updatedAt: new Date().toISOString()
			},
			updatedAt: new Date().toISOString()
		},
		autoTopup: {
			status: 'idle',
			account: null,
			updatedAt: new Date().toISOString()
		},
		activeCycle: {
			cycleNumber: 7,
			stage: 'waiting_fill',
			price: 10,
			holdSecondsTarget: 1,
			plannedNotionalUsd: 100,
			currentQuantity: 10,
			updatedAt: new Date().toISOString()
		},
		history: [],
		logs: [],
		config: null,
		updatedAt: new Date().toISOString()
	};
	const accounts = {
		accountA: createManagedAccount('accountA'),
		accountB: createManagedAccount('accountB')
	};
	const db = {
		getNextCycleNumber: vi.fn().mockResolvedValue(1),
		createCycle: vi.fn().mockResolvedValue(1),
		...dbOverrides
	};

	const context: RuntimeCycleContext = {
		getConfig: () => ({ ...createConfig(), ...configOverrides }),
		getService: () => service as never,
		getAccounts: () => accounts,
		getDb: () => db as never,
		getSnapshot: () => snapshot,
		getCurrentCycleId: () => 1,
		setCurrentCycleId: vi.fn(),
		getCurrentCycleAuxiliaryGasUsd: () => currentCycleAuxiliaryGasUsd,
		setCurrentCycleAuxiliaryGasUsd: vi.fn((value: number) => {
			currentCycleAuxiliaryGasUsd = value;
		}),
		getCurrentCycleOrders: () => currentCycleOrders,
		setCurrentCycleOrders: vi.fn(),
		appendLog: async (level, message, meta) => {
			logs.push({ level, message, meta });
		},
		persistCurrentOrders: async () => {},
		setActiveCycle: vi.fn(),
		refreshSnapshot: async () => {},
		setSnapshot: (overrides) => Object.assign(snapshot, overrides),
		setAutoTopupSnapshot: vi.fn(),
		updateBalancesAndPreflight: vi.fn(),
		accountLabel: (account) => (account === 'accountA' ? 'Account A' : 'Account B'),
		throwIfStopping: () => {},
		sleepInterruptible: async () => {},
		randomDelay: async () => {},
		withRetry: async (_label, fn) => fn()
	};

	return { context, logs, currentCycleOrders, accounts, snapshot, db };
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('runtime-cycle-executor', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('stops sending referral after the first successful OPEN submit', async () => {
		const referralFlags: boolean[] = [];
		const service = {
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			placeMarginLimitOrder: vi.fn().mockImplementation(async (input) => {
				referralFlags.push(input.setMarginManagerReferral);
				return {
					txDigest: `tx-${referralFlags.length}`,
					orderId: `${referralFlags.length}`,
					clientOrderId: input.clientOrderId,
					paidFeesQuote: 0,
					gasUsedSui: 0
				};
			})
		};
		const { context, accounts } = createContext(service);
		const executor = new RuntimeCycleExecutor(context);

		await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50
		});
		await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50
		});

		expect(referralFlags).toEqual([true, false]);
	});

	it('keeps sending referral on later OPEN orders if earlier submits only failed', async () => {
		const referralFlags: boolean[] = [];
		let submitCalls = 0;
		const service = {
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			placeMarginLimitOrder: vi.fn().mockImplementation(async (input) => {
				submitCalls += 1;
				referralFlags.push(input.setMarginManagerReferral);
				if (submitCalls <= 3) {
					throw new Error(`submit failed ${submitCalls}`);
				}
				return {
					txDigest: `tx-${submitCalls}`,
					orderId: `${submitCalls}`,
					clientOrderId: input.clientOrderId,
					paidFeesQuote: 0,
					gasUsedSui: 0
				};
			})
		};
		const { context, accounts, currentCycleOrders } = createContext(service);
		const executor = new RuntimeCycleExecutor(context);

		await expect(
			executor.submitMakerOrder({
				account: accounts.accountA,
				side: 'LONG',
				phase: 'OPEN',
				isBid: true,
				price: 10,
				quantity: 5,
				notionalUsd: 50
			})
		).rejects.toThrow('submit failed 3');

		await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50
		});

		expect(referralFlags).toEqual([true, true, true, true]);
		expect(currentCycleOrders[1]?.status).toBe('open');
	});

	it('reconciles a missing order id from the open-order fallback path', async () => {
		let openOrderCalls = 0;
		const service = {
			getAccountOpenOrders: vi.fn().mockImplementation(async () => {
				openOrderCalls += 1;
				return openOrderCalls >= 3 ? ['9'] : [];
			}),
			getOrderIdFromTransaction: vi.fn().mockResolvedValue(undefined),
			placeMarginLimitOrder: vi.fn().mockResolvedValue({
				txDigest: 'tx-1',
				orderId: undefined,
				clientOrderId: '1',
				paidFeesQuote: 0,
				gasUsedSui: 0
			})
		};
		const { context, accounts, logs } = createContext(service);
		const executor = new RuntimeCycleExecutor(context);

		const result = await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50
		});

		expect(result.orderId).toBe('9');
		expect(logs.some((entry) => entry.message.includes('reconciled from open orders'))).toBe(true);
	});

	it('uses the boundary price for OPEN residual retry after a partial fill', async () => {
		const submittedPrices: number[] = [];
		const service = {
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			placeMarginLimitOrder: vi.fn().mockImplementation(async (input) => {
				submittedPrices.push(input.price);
				return {
					txDigest: `tx-${submittedPrices.length}`,
					orderId: `${111 + submittedPrices.length}`,
					clientOrderId: input.clientOrderId,
					paidFeesQuote: 0,
					gasUsedSui: 0
				};
			}),
			getOrder: vi.fn().mockImplementation(async (_account, orderId) => {
				if (orderId === '112') {
					return { quantity: 10, filledQuantity: 4 };
				}
				return null;
			}),
			cancelAllOrders: vi.fn().mockResolvedValue(undefined),
			withdrawSettled: vi.fn().mockResolvedValue(undefined),
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.2,
				tickSize: 0.1,
				lotSize: 1,
				minSize: 1,
				midPrice: 10.05
			}),
			getMarginManagerState: vi.fn().mockResolvedValue({
				managerId: 'manager-accountA',
				balanceManagerId: 'balance-accountA',
				baseAsset: 4,
				quoteAsset: 100,
				baseDebt: 0,
				quoteDebt: 0,
				riskRatio: 0,
				currentPrice: 10
			})
		};
		const { context, accounts, logs } = createContext(service);
		const executor = new RuntimeCycleExecutor(context);

		const submitted = await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 10,
			notionalUsd: 100
		});

		await executor.waitForFullFill(submitted.orderIndex, 10);

		expect(submittedPrices).toEqual([10, 9.9]);
		expect(
			logs.some((entry) =>
				entry.message.includes('Using boundary price for long open residual retry')
			)
		).toBe(true);
	});

	it('routes OPEN and SHORT CLOSE submits through market execution when configured', async () => {
		const marketCalls: Array<{ phase: 'OPEN' | 'CLOSE'; isBid: boolean; quantity: number }> = [];
		const limitOrder = vi.fn();
		const service = {
			placeMarginMarketOrder: vi.fn().mockImplementation(async (input) => {
				marketCalls.push({
					phase: input.borrowQuote ? 'OPEN' : 'CLOSE',
					isBid: input.isBid,
					quantity: input.quantity
				});
				return {
					txDigest: `tx-${marketCalls.length}`,
					orderId: undefined,
					clientOrderId: input.clientOrderId,
					paidFeesQuote: input.borrowQuote ? 0.012345 : 0.023456,
					gasUsedSui: 0,
					filledQuantity: input.borrowQuote ? 4.8 : 5,
					averageFillPrice: input.borrowQuote ? 9.87 : 10.23
				};
			}),
			placeMarginLimitOrder: limitOrder,
			placeMarginLimitOrderDeeptradeStyle: limitOrder,
			getOrder: vi.fn()
		};
		const { context, accounts, currentCycleOrders } = createContext(service, {
			open_order_execution_mode: 'market',
			close_order_execution_mode: 'market',
			experimental_deeptrade_limit_ptb: true
		});
		const executor = new RuntimeCycleExecutor(context);

		const openResult = await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50,
			borrowQuote: 50
		});
		const closeResult = await executor.submitMakerOrder({
			account: accounts.accountB,
			side: 'SHORT',
			phase: 'CLOSE',
			isBid: true,
			price: 10.1,
			quantity: 5,
			notionalUsd: 50.5
		});

		expect(marketCalls).toEqual([
			{ phase: 'OPEN', isBid: true, quantity: 5 },
			{ phase: 'CLOSE', isBid: true, quantity: 5 }
		]);
		expect(limitOrder).not.toHaveBeenCalled();
		expect(openResult.orderId).toBeTruthy();
		expect(closeResult.orderId).toBeTruthy();
		expect(openResult.price).toBe(9.87);
		expect(closeResult.price).toBe(10.23);
		expect(currentCycleOrders[0]?.price).toBe(9.87);
		expect(currentCycleOrders[0]?.quantity).toBe(4.8);
		expect(currentCycleOrders[0]?.filledPrice).toBe(9.87);
		expect(currentCycleOrders[0]?.filledQuantity).toBe(4.8);
		expect(currentCycleOrders[0]?.paidFeesQuote).toBe(0.012345);
		expect(currentCycleOrders[1]?.price).toBe(10.23);
		expect(currentCycleOrders[1]?.quantity).toBe(5);
		expect(currentCycleOrders[1]?.filledPrice).toBe(10.23);
		expect(currentCycleOrders[1]?.filledQuantity).toBe(5);
		expect(currentCycleOrders[1]?.paidFeesQuote).toBe(0.023456);

		const openFill = await executor.waitForFullFill(openResult.orderIndex, 5);
		expect(openFill.quantity).toBe(4.8);
		expect(openFill.paidFees).toBe(0.012345);
		expect(service.getOrder).not.toHaveBeenCalled();
	});

	it('preserves service context for DeepTrade-style LONG OPEN limit submits', async () => {
		const service = {
			sdk: { ok: true },
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			placeMarginLimitOrder: vi.fn(),
			placeMarginLimitOrderDeeptradeStyle: vi.fn(function (this: any, input: any) {
				// This path historically failed when method was called unbound.
				this.sdk.ok;
				return Promise.resolve({
					txDigest: 'tx-deeptrade-open',
					orderId: 'deeptrade-open-1',
					clientOrderId: input.clientOrderId,
					paidFeesQuote: 0.01,
					gasUsedSui: 0
				});
			})
		};
		const { context, accounts } = createContext(service, {
			open_order_execution_mode: 'limit',
			experimental_deeptrade_limit_ptb: true
		});
		const executor = new RuntimeCycleExecutor(context);

		const result = await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50
		});

		expect(result.orderId).toBe('deeptrade-open-1');
		expect(service.placeMarginLimitOrderDeeptradeStyle).toHaveBeenCalledTimes(1);
		expect(service.placeMarginLimitOrder).not.toHaveBeenCalled();
	});

	it('keeps LONG OPEN limit on classic submit path when DeepTrade PTB flag is disabled', async () => {
		const service = {
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			placeMarginLimitOrderDeeptradeStyle: vi.fn().mockResolvedValue({
				txDigest: 'tx-deeptrade-open',
				orderId: 'deeptrade-open-1',
				clientOrderId: 'unused',
				paidFeesQuote: 0.01,
				gasUsedSui: 0
			}),
			placeMarginLimitOrder: vi.fn().mockImplementation(async (input) => ({
				txDigest: 'tx-classic-open',
				orderId: 'classic-open-1',
				clientOrderId: input.clientOrderId,
				paidFeesQuote: 0.01,
				gasUsedSui: 0
			})),
			getOrder: vi.fn()
		};
		const { context, accounts } = createContext(service, {
			open_order_execution_mode: 'limit',
			experimental_deeptrade_limit_ptb: false
		});
		const executor = new RuntimeCycleExecutor(context);

		const result = await executor.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: 10,
			quantity: 5,
			notionalUsd: 50
		});

		expect(result.orderId).toBe('classic-open-1');
		expect(service.placeMarginLimitOrder).toHaveBeenCalledTimes(1);
		expect(service.placeMarginLimitOrderDeeptradeStyle).not.toHaveBeenCalled();
	});

	it('delegates LONG CLOSE market orders to the dedicated repay PTB and records actual sold quantity', async () => {
		const service = {
			placeLongCloseMarketOrderAndRepayQuote: vi.fn().mockResolvedValue({
				txDigest: 'close-tx',
				orderId: undefined,
				clientOrderId: 'ignored',
				paidFeesQuote: 0.031234,
				gasUsedSui: 0.02,
				filledQuantity: 20.95,
				averageFillPrice: 0.952341,
				netQuoteDebt: 19.954706,
				computedSellQuantity: 21
			}),
			getOrder: vi.fn()
		};
		const { context, accounts, currentCycleOrders, logs } = createContext(service, {
			close_order_execution_mode: 'market'
		});
		const executor = new RuntimeCycleExecutor(context);

		const result = await executor.submitLongCloseMarketOrder({
			account: accounts.accountA,
			closeState: {
				state: {
					managerId: 'manager-accountA',
					balanceManagerId: 'balance-accountA',
					baseAsset: 32.7,
					quoteAsset: 0.065498,
					baseDebt: 0,
					quoteDebt: 20.020204,
					riskRatio: 0,
					currentPrice: 0.951626
				},
				closeQuantity: 32.7
			},
			referencePrice: 0.951626
		});

		expect(service.placeLongCloseMarketOrderAndRepayQuote).toHaveBeenCalledWith(
			expect.objectContaining({
				account: accounts.accountA,
				targetQuoteDebt: 20.020204,
				maxBaseQuantity: 32.7
			})
		);
		expect(result.orderId).toBeTruthy();
		expect(currentCycleOrders[0]).toMatchObject({
			account: 'accountA',
			side: 'LONG',
			phase: 'CLOSE',
			price: 0.952341,
			quantity: 20.95,
			filledPrice: 0.952341,
			filledQuantity: 20.95,
			paidFeesQuote: 0.031234,
			status: 'filled'
		});
		expect(logs.some((entry) => entry.meta.netQuoteDebt === 19.954706)).toBe(true);
		expect(logs.some((entry) => entry.meta.computedSellQuantity === 21)).toBe(true);

		const closeFill = await executor.waitForFullFill(result.orderIndex, 32.7);
		expect(closeFill.quantity).toBe(20.95);
		expect(closeFill.price).toBe(0.952341);
		expect(closeFill.paidFees).toBe(0.031234);
		expect(service.getOrder).not.toHaveBeenCalled();
	});

	it('caps auto-reduced cycle notional at the affordable ceiling even when jitter is positive', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			})
		};
		const { context, snapshot, db } = createContext(
			service,
			{
				notional_size_usd: 100,
				random_size_bps: 1000,
				auto_swap_enabled: false,
				auto_swap_buffer_bps: 0,
				slippage_tolerance: 0,
				min_gas_reserve_sui: 0,
				notional_auto_reduce_floor_pct: 50
			},
			{
				createCycle: vi.fn().mockRejectedValue(new Error('stop-after-create'))
			}
		);
		snapshot.balances = {
			source: 'wallet',
			accountA: { sui: 7.324, usdc: 0, totalUsdc: 73.24, updatedAt: new Date().toISOString() },
			accountB: { sui: 0, usdc: 80, totalUsdc: 80, updatedAt: new Date().toISOString() },
			totalUsdc: 153.24,
			updatedAt: new Date().toISOString()
		};
		const executor = new RuntimeCycleExecutor(context);

		await expect(executor.executeCycle()).rejects.toThrow('stop-after-create');

		expect(db.createCycle).toHaveBeenCalledWith(
			expect.objectContaining({
				plannedNotionalUsd: 73.2
			})
		);
	});

	it('does not create a cycle row when funding fails before the first order', async () => {
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			})
		};
		const { context, db } = createContext(service, {
			auto_swap_enabled: true,
			auto_swap_buffer_bps: 0,
			slippage_tolerance: 0,
			min_gas_reserve_sui: 0
		});
		const executor = new RuntimeCycleExecutor(context);
		vi.spyOn(executor, 'planWalletFundingForCycle').mockRejectedValue(new Error('funding-short'));

		await expect(executor.executeCycle()).rejects.toThrow('funding-short');

		expect(db.createCycle).not.toHaveBeenCalled();
	});

	it('funds LONG market opens with base collateral and optional wallet quote dust', async () => {
		const marketCalls: Array<Record<string, number | boolean | string | undefined>> = [];
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			}),
			placeMarginMarketOrder: vi.fn().mockImplementation(async (input) => {
				marketCalls.push({
					account: input.account.key,
					depositBase: input.depositBase,
					depositQuote: input.depositQuote,
					borrowQuote: input.borrowQuote,
					borrowBase: input.borrowBase,
					isBid: input.isBid
				});
				return {
					txDigest: 'tx-open',
					orderId: 'open-1',
					clientOrderId: input.clientOrderId,
					paidFeesQuote: 0.01,
					gasUsedSui: 0,
					filledQuantity: input.quantity,
					averageFillPrice: 10
				};
			})
		};
		const { context, snapshot } = createContext(service, {
			open_order_execution_mode: 'market',
			account_a_borrow_quote_factor: 2,
			account_b_borrow_base_factor: 2,
			auto_swap_enabled: false,
			min_gas_reserve_sui: 0
		});
		snapshot.balances = {
			source: 'wallet',
			accountA: { sui: 10, usdc: 0.2, totalUsdc: 100.2, updatedAt: new Date().toISOString() },
			accountB: { sui: 0, usdc: 100, totalUsdc: 100, updatedAt: new Date().toISOString() },
			totalUsdc: 200.2,
			updatedAt: new Date().toISOString()
		};
		context.randomDelay = vi.fn().mockRejectedValue(new Error('stop-after-long-open'));
		const executor = new RuntimeCycleExecutor(context);

		await expect(executor.executeCycle()).rejects.toThrow('stop-after-long-open');

		expect(service.placeMarginMarketOrder).toHaveBeenCalledTimes(1);
		expect(marketCalls).toEqual([
			{
				account: 'accountA',
				depositBase: 5,
				depositQuote: 0.2,
				borrowQuote: 50,
				borrowBase: undefined,
				isBid: true
			}
		]);
	});

	it('sizes LONG limit OPEN quantity from available quote budget instead of full cycle quantity', async () => {
		const limitCalls: Array<Record<string, number | boolean | string | undefined>> = [];
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			}),
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			placeMarginLimitOrder: vi.fn().mockImplementation(async (input) => {
				limitCalls.push({
					account: input.account.key,
					quantity: input.quantity,
					price: input.price,
					depositBase: input.depositBase,
					depositQuote: input.depositQuote,
					borrowQuote: input.borrowQuote,
					borrowBase: input.borrowBase,
					isBid: input.isBid
				});
				throw new Error('stop-after-long-limit-open');
			})
		};
		const { context, snapshot } = createContext(service, {
			open_order_execution_mode: 'limit',
			close_order_execution_mode: 'limit',
			account_a_borrow_quote_factor: 2,
			account_b_borrow_base_factor: 2,
			auto_swap_enabled: false,
			min_gas_reserve_sui: 0
		});
		snapshot.balances = {
			source: 'wallet',
			accountA: { sui: 10, usdc: 0, totalUsdc: 100, updatedAt: new Date().toISOString() },
			accountB: { sui: 0, usdc: 100, totalUsdc: 100, updatedAt: new Date().toISOString() },
			totalUsdc: 200,
			updatedAt: new Date().toISOString()
		};
		const executor = new RuntimeCycleExecutor(context);

		await expect(executor.executeCycle()).rejects.toThrow('stop-after-long-limit-open');

		expect(service.placeMarginLimitOrder).toHaveBeenCalled();
		expect(limitCalls[0]).toMatchObject({
			account: 'accountA',
			isBid: true,
			price: 9.9,
			quantity: 5,
			depositBase: 5,
			depositQuote: undefined,
			borrowQuote: 50,
			borrowBase: undefined
		});
	});

	it('logs each open fill as soon as that leg resolves', async () => {
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			})
		};
		const { context, logs, accounts } = createContext(
			service,
			{
				auto_swap_enabled: false,
				min_gas_reserve_sui: 0
			},
			{
				markCycleHolding: vi.fn().mockRejectedValue(new Error('stop-after-hold-start'))
			}
		);
		const executor = new RuntimeCycleExecutor(context);
		const longFill = createDeferred<{
			price: number;
			paidFees: number;
			quantity: number;
			txDigest?: string;
		}>();
		const shortFill = createDeferred<{
			price: number;
			paidFees: number;
			quantity: number;
			txDigest?: string;
		}>();

		vi.spyOn(executor, 'planWalletFundingForCycle').mockResolvedValue({
			accountA: null,
			accountB: null
		});
		vi.spyOn(executor, 'submitMakerOrder')
			.mockResolvedValueOnce({ orderIndex: 0, orderId: 'long-open', price: 9.9 })
			.mockResolvedValueOnce({ orderIndex: 1, orderId: 'short-open', price: 10.1 });
		const waitForFullFillSpy = vi
			.spyOn(executor, 'waitForFullFill')
			.mockImplementationOnce(() => longFill.promise)
			.mockImplementationOnce(() => shortFill.promise);
		vi.spyOn(executor, 'settleFilledBalances').mockResolvedValue();
		context.randomDelay = vi.fn().mockResolvedValue(undefined);

		const runPromise = executor.executeCycle();
		await vi.waitFor(() => {
			expect(waitForFullFillSpy).toHaveBeenCalledTimes(2);
		});

		longFill.resolve({
			price: 10.04,
			paidFees: 0.01,
			quantity: 10,
			txDigest: 'long-fill'
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(
			logs.some(
				(entry) =>
					entry.message === 'LONG leg is filled; waiting for hold window on cycle #1' &&
					entry.meta.account === accounts.accountA.label &&
					entry.meta.txDigest === 'long-fill'
			)
		).toBe(true);
		expect(
			logs.some((entry) => entry.message === 'SHORT leg is filled; waiting for hold window on cycle #1')
		).toBe(false);

		shortFill.resolve({
			price: 10.05,
			paidFees: 0.01,
			quantity: 10,
			txDigest: 'short-fill'
		});

		await expect(runPromise).rejects.toThrow('stop-after-hold-start');
		expect(
			logs.some(
				(entry) =>
					entry.message === 'SHORT leg is filled; waiting for hold window on cycle #1' &&
					entry.meta.account === accounts.accountB.label &&
					entry.meta.txDigest === 'short-fill'
			)
		).toBe(true);
	});

	it('uses slower retry floor for withdraw settled after fill', async () => {
		const service = {
			withdrawSettled: vi.fn().mockResolvedValue({ txDigest: '0xsettle', gasUsedSui: 0.001 })
		};
		const { context, accounts, logs } = createContext(service);
		const withRetrySpy = vi.fn(async (_label, fn) => fn());
		context.withRetry = withRetrySpy;
		const executor = new RuntimeCycleExecutor(context);

		await executor.settleFilledBalances(
			[{ account: accounts.accountA, side: 'LONG' }],
			266,
			'OPEN'
		);

		expect(withRetrySpy).toHaveBeenCalledWith(
			'withdraw settled amounts after fill',
			expect.any(Function),
			3,
			expect.objectContaining({
				account: accounts.accountA.label,
				side: 'LONG',
				phase: 'OPEN',
				cycleNumber: 266
			}),
			expect.objectContaining({
				minRetryDelayMs: 2500
			})
		);
		expect(
			logs.some(
				(entry) =>
					entry.level === 'info' &&
					entry.message === 'withdraw settled amounts after fill succeeded.' &&
					entry.meta.account === accounts.accountA.label &&
					entry.meta.accountKey === accounts.accountA.key &&
					entry.meta.side === 'LONG' &&
					entry.meta.phase === 'OPEN' &&
					entry.meta.cycleNumber === 266 &&
					entry.meta.txDigest === '0xsettle'
			)
		).toBe(true);
	});

	it('uses longer retries for repay residual debts after limit close fills', async () => {
		const service = {
			repayFromManagerAndWithdraw: vi
				.fn()
				.mockResolvedValue({ txDigest: '0xrepay', gasUsedSui: 0.002 })
		};
		const { context, accounts } = createContext(service);
		const withRetrySpy = vi.fn(async (_label, fn) => fn());
		context.withRetry = withRetrySpy;
		const executor = new RuntimeCycleExecutor(context);

		await executor.repayLimitCloseResiduals(
			[{ account: accounts.accountB, side: 'SHORT' }],
			266
		);

		expect(withRetrySpy).toHaveBeenCalledWith(
			'repay residual debts after limit close fills',
			expect.any(Function),
			3,
			expect.objectContaining({
				account: accounts.accountB.label,
				side: 'SHORT',
				phase: 'CLOSE',
				cycleNumber: 266
			})
		);
	});

	it('preserves the close-state retry labels and log payloads for both loaders', async () => {
		const service = {
			getMarginManagerState: vi
				.fn()
				.mockResolvedValueOnce({
					managerId: 'manager-accountA',
					balanceManagerId: 'balance-accountA',
					baseAsset: 12.345678901,
					quoteAsset: 67.890123456,
					baseDebt: 1.23456789,
					quoteDebt: 9.87654321,
					riskRatio: 0,
					currentPrice: 10.123456
				})
				.mockResolvedValueOnce({
					managerId: 'manager-accountB',
					balanceManagerId: 'balance-accountB',
					baseAsset: 0.123456789,
					quoteAsset: 45.678901234,
					baseDebt: 98.765432109,
					quoteDebt: 0.987654321,
					riskRatio: 0,
					currentPrice: 10.654321
				})
		};
		const { context, accounts, logs } = createContext(service);
		const withRetrySpy = vi.fn(async (_label, fn) => fn());
		context.withRetry = withRetrySpy;
		const executor = new RuntimeCycleExecutor(context);

		await expect(executor.loadCloseState(accounts.accountA, 77, 'LONG')).resolves.toEqual({
			state: expect.objectContaining({
				baseAsset: 12.345678901,
				baseDebt: 1.23456789
			}),
			closeQuantity: 12.345678901
		});
		await expect(executor.reloadCloseResidualState(accounts.accountB, 78, 'SHORT')).resolves.toEqual(
			{
				state: expect.objectContaining({
					baseAsset: 0.123456789,
					baseDebt: 98.765432109
				}),
				closeQuantity: 98.765432109
			}
		);

		expect(withRetrySpy).toHaveBeenNthCalledWith(
			1,
			'load close preparation state',
			expect.any(Function),
			3,
			expect.objectContaining({
				account: accounts.accountA.label,
				side: 'LONG',
				phase: 'CLOSE',
				cycleNumber: 77
			})
		);
		expect(withRetrySpy).toHaveBeenNthCalledWith(
			2,
			'reload close residual state',
			expect.any(Function),
			3,
			expect.objectContaining({
				account: accounts.accountB.label,
				side: 'SHORT',
				phase: 'CLOSE',
				cycleNumber: 78
			})
		);
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: 'info',
					message: 'LONG close state prepared',
					meta: expect.objectContaining({
						account: accounts.accountA.label,
						accountKey: accounts.accountA.key,
						side: 'LONG',
						phase: 'CLOSE',
						cycleNumber: 77,
						baseAsset: 12.345678901,
						quoteAsset: 67.890123,
						baseDebt: 1.23456789,
						quoteDebt: 9.876543,
						closeQuantity: 12.345678901,
						referencePrice: 10.123456
					})
				}),
				expect.objectContaining({
					level: 'info',
					message: 'SHORT close residual recalculated from manager state.',
					meta: expect.objectContaining({
						account: accounts.accountB.label,
						accountKey: accounts.accountB.key,
						side: 'SHORT',
						phase: 'CLOSE',
						cycleNumber: 78,
						baseAsset: 0.123456789,
						quoteAsset: 45.678901,
						baseDebt: 98.765432109,
						quoteDebt: 0.987654,
						closeQuantity: 98.765432109,
						referencePrice: 10.654321
					})
				})
			])
		);
	});

	it('fails cycle completion when post-close manager state still requires cleanup', async () => {
		const finishCycle = vi.fn().mockResolvedValue(undefined);
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			}),
			getMarginManagerState: vi.fn(),
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			repayFromManagerAndWithdraw: vi
				.fn()
				.mockResolvedValue({ txDigest: 'repay-residual', gasUsedSui: 0.01 })
		};
		const { context, accounts } = createContext(
			service,
			{
				auto_swap_enabled: false,
				min_gas_reserve_sui: 0
			},
			{
				markCycleHolding: vi.fn().mockResolvedValue(undefined),
				updateCycleOrders: vi.fn().mockResolvedValue(undefined),
				finishCycle
			}
		);
		const executor = new RuntimeCycleExecutor(context);

		vi.spyOn(executor, 'planWalletFundingForCycle').mockResolvedValue({
			accountA: null,
			accountB: null
		});
		vi.spyOn(executor, 'submitMakerOrder')
			.mockResolvedValueOnce({ orderIndex: 0, orderId: 'long-open', price: 9.9 })
			.mockResolvedValueOnce({ orderIndex: 1, orderId: 'short-open', price: 10.1 })
			.mockResolvedValueOnce({ orderIndex: 2, orderId: 'long-close', price: 10.1 })
			.mockResolvedValueOnce({ orderIndex: 3, orderId: 'short-close', price: 9.9 });
		vi.spyOn(executor, 'waitForFullFill')
			.mockResolvedValueOnce({
				price: 10,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'long-open-fill'
			})
			.mockResolvedValueOnce({
				price: 10,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'short-open-fill'
			})
			.mockResolvedValueOnce({
				price: 10.05,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'long-close-fill'
			})
			.mockResolvedValueOnce({
				price: 10.05,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'short-close-fill'
			});
		vi.spyOn(executor, 'settleFilledBalances').mockResolvedValue();
		vi.spyOn(executor, 'loadCloseState')
			.mockResolvedValueOnce({
				state: {
					managerId: 'manager-accountA',
					balanceManagerId: 'balance-accountA',
					baseAsset: 10,
					quoteAsset: 0,
					baseDebt: 0,
					quoteDebt: 0,
					riskRatio: 0,
					currentPrice: 10
				},
				closeQuantity: 10
			})
			.mockResolvedValueOnce({
				state: {
					managerId: 'manager-accountB',
					balanceManagerId: 'balance-accountB',
					baseAsset: 0,
					quoteAsset: 100,
					baseDebt: 10,
					quoteDebt: 0,
					riskRatio: 0,
					currentPrice: 10
				},
				closeQuantity: 10
			});
		service.getMarginManagerState
			.mockResolvedValueOnce({
				managerId: 'manager-accountA',
				balanceManagerId: 'balance-accountA',
				baseAsset: 0.076273,
				quoteAsset: 61.01872,
				baseDebt: 0,
				quoteDebt: 40.582062,
				riskRatio: 0,
				currentPrice: 10
			})
			.mockResolvedValueOnce({
				managerId: 'manager-accountB',
				balanceManagerId: 'balance-accountB',
				baseAsset: 74,
				quoteAsset: 16.026487,
				baseDebt: 69.200386,
				quoteDebt: 0,
				riskRatio: 0,
				currentPrice: 10
			});

		await expect(executor.executeCycle()).rejects.toThrow(/close verification failed/i);
		expect(finishCycle).not.toHaveBeenCalled();
	});

	it('runs repay-and-withdraw for both accounts after limit close fills', async () => {
		const finishCycle = vi.fn().mockResolvedValue(undefined);
		const repayFromManagerAndWithdraw = vi
			.fn()
			.mockResolvedValue({ txDigest: 'repay-tx', gasUsedSui: 0.01 });
		const service = {
			getOrderBookTop: vi.fn().mockResolvedValue({
				bestBid: 9.9,
				bestAsk: 10.1,
				tickSize: 0.1,
				lotSize: 0.1,
				minSize: 0.1,
				midPrice: 10
			}),
			getMarginManagerState: vi
				.fn()
				.mockResolvedValueOnce({
					managerId: 'manager-accountA',
					balanceManagerId: 'balance-accountA',
					baseAsset: 0,
					quoteAsset: 0,
					baseDebt: 0,
					quoteDebt: 0,
					riskRatio: 0,
					currentPrice: 10
				})
				.mockResolvedValueOnce({
					managerId: 'manager-accountB',
					balanceManagerId: 'balance-accountB',
					baseAsset: 0,
					quoteAsset: 0,
					baseDebt: 0,
					quoteDebt: 0,
					riskRatio: 0,
					currentPrice: 10
				}),
			getAccountOpenOrders: vi.fn().mockResolvedValue([]),
			repayFromManagerAndWithdraw
		};
		const { context, accounts } = createContext(
			service,
			{
				auto_swap_enabled: false,
				min_gas_reserve_sui: 0,
				close_order_execution_mode: 'limit'
			},
			{
				markCycleHolding: vi.fn().mockResolvedValue(undefined),
				updateCycleOrders: vi.fn().mockResolvedValue(undefined),
				finishCycle
			}
		);
		const executor = new RuntimeCycleExecutor(context);

		vi.spyOn(executor, 'planWalletFundingForCycle').mockResolvedValue({
			accountA: null,
			accountB: null
		});
		vi.spyOn(executor, 'submitMakerOrder')
			.mockResolvedValueOnce({ orderIndex: 0, orderId: 'long-open', price: 9.9 })
			.mockResolvedValueOnce({ orderIndex: 1, orderId: 'short-open', price: 10.1 })
			.mockResolvedValueOnce({ orderIndex: 2, orderId: 'long-close', price: 10.1 })
			.mockResolvedValueOnce({ orderIndex: 3, orderId: 'short-close', price: 9.9 });
		vi.spyOn(executor, 'waitForFullFill')
			.mockResolvedValueOnce({
				price: 10,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'long-open-fill'
			})
			.mockResolvedValueOnce({
				price: 10,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'short-open-fill'
			})
			.mockResolvedValueOnce({
				price: 10.05,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'long-close-fill'
			})
			.mockResolvedValueOnce({
				price: 10.05,
				paidFees: 0.01,
				quantity: 10,
				txDigest: 'short-close-fill'
			});
		vi.spyOn(executor, 'settleFilledBalances').mockResolvedValue();
		vi.spyOn(executor, 'loadCloseState')
			.mockResolvedValueOnce({
				state: {
					managerId: 'manager-accountA',
					balanceManagerId: 'balance-accountA',
					baseAsset: 10,
					quoteAsset: 0,
					baseDebt: 0,
					quoteDebt: 0,
					riskRatio: 0,
					currentPrice: 10
				},
				closeQuantity: 10
			})
			.mockResolvedValueOnce({
				state: {
					managerId: 'manager-accountB',
					balanceManagerId: 'balance-accountB',
					baseAsset: 0,
					quoteAsset: 100,
					baseDebt: 10,
					quoteDebt: 0,
					riskRatio: 0,
					currentPrice: 10
				},
				closeQuantity: 10
			});

		await executor.executeCycle();

		expect(repayFromManagerAndWithdraw).toHaveBeenCalledTimes(2);
		expect(repayFromManagerAndWithdraw).toHaveBeenNthCalledWith(1, accounts.accountA);
		expect(repayFromManagerAndWithdraw).toHaveBeenNthCalledWith(2, accounts.accountB);
		expect(finishCycle).toHaveBeenCalledTimes(1);
	});
});
