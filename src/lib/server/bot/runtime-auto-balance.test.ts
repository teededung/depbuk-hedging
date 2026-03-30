import { beforeEach, describe, expect, it, vi } from 'vitest';

type WalletBalances = ReturnType<typeof createWalletBalances>;

function createWalletBalances() {
	return {
		source: 'wallet' as const,
		accountA: {
			sui: 0,
			usdc: 0,
			totalUsdc: 0,
			updatedAt: new Date(0).toISOString()
		},
		accountB: {
			sui: 0,
			usdc: 0,
			totalUsdc: 0,
			updatedAt: new Date(0).toISOString()
		},
		totalUsdc: 0,
		updatedAt: new Date(0).toISOString()
	};
}

const runtimeMockState = vi.hoisted(() => ({
	config: {
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
	},
	settingsRow: {},
	logs: [] as Array<{
		id: number;
		level: string;
		message: string;
		meta: Record<string, unknown>;
		createdAt: string;
	}>,
	nextLogId: 1,
	referencePrice: 10,
	balanceResponses: [] as WalletBalances[],
	currentBalances: createWalletBalances(),
	managerStates: {
		accountA: {
			managerId: 'accountA-mm',
			balanceManagerId: 'accountA-bm',
			baseAsset: 0,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 10
		},
		accountB: {
			managerId: 'accountB-mm',
			balanceManagerId: 'accountB-bm',
			baseAsset: 0,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 10
		}
	},
	openOrders: {
		accountA: [] as Array<Record<string, unknown>>,
		accountB: [] as Array<Record<string, unknown>>
	},
	getWalletBalancesCallCount: 0,
	swapCalls: [] as Array<{ accountKey: 'accountA' | 'accountB'; amountIn: number }>,
	swapFailures: {} as Partial<Record<'accountA' | 'accountB', Error>>,
	transferCalls: [] as Array<{
		from: 'accountA' | 'accountB';
		to: 'accountA' | 'accountB';
		asset: 'USDC' | 'SUI';
		amount: number;
	}>,
	transferFailure: null as Error | null
}));

vi.mock('./db.js', () => {
	class BotDatabase {
		async init() {}
		async disconnect() {}
		async getSettings() {
			return runtimeMockState.settingsRow;
		}
		async loadAccountState() {
			return {};
		}
		async saveAccountState() {}
		async upsertManagerCache() {}
		async getDashboardStats() {
			return {
				totalVolumeAllTime: 0,
				totalVolumeToday: 0,
				totalVolumeAccountA: 0,
				totalVolumeAccountB: 0,
				sessionPnl: 0,
				sessionFees: 0,
				sessionGas: 0,
				cyclesCompleted: 0,
				updatedAt: new Date(0).toISOString()
			};
		}
		async listRecentCycles() {
			return [];
		}
		async listLogs() {
			return runtimeMockState.logs;
		}
		async appendLog(level: string, message: string, meta: Record<string, unknown>) {
			const entry = {
				id: runtimeMockState.nextLogId++,
				level,
				message,
				meta,
				createdAt: new Date().toISOString()
			};
			runtimeMockState.logs.push(entry);
			return entry;
		}
		async countCyclesSince() {
			return 0;
		}
	}

	return { BotDatabase };
});

vi.mock('./config.js', () => ({
	sanitizeSettings: (value: unknown) => value,
	validateSettingsInput: (input: unknown) => input,
	toBotConfig: () => runtimeMockState.config,
	toReadOnlyBotConfig: () => runtimeMockState.config,
	toConfigSummary: () => ({
		network: runtimeMockState.config.network,
		rpcUrl: runtimeMockState.config.rpc_url,
		experimentalDeeptradeLimitPtb: runtimeMockState.config.experimental_deeptrade_limit_ptb,
		deeptradeOrderbookApiBase: runtimeMockState.config.deeptrade_orderbook_api_base,
		poolKey: runtimeMockState.config.pool_key,
		accountALabel: runtimeMockState.config.account_a_label,
		accountBLabel: runtimeMockState.config.account_b_label,
		hasPrivateKeyA: true,
		hasPrivateKeyB: true,
		notionalSizeUsd: runtimeMockState.config.notional_size_usd,
		holdRangeSeconds: [
			runtimeMockState.config.min_hold_seconds,
			runtimeMockState.config.max_hold_seconds
		] as [number, number],
		maxCycles: runtimeMockState.config.max_cycles,
		slippageTolerance: runtimeMockState.config.slippage_tolerance,
		settingsApplyPending: false
	})
}));

vi.mock('./deepbook.js', () => {
	class DeepBookService {
		coins = {
			SUI: { type: '0x2::sui::SUI' },
			USDC: { type: '0xusdc::usdc::USDC' }
		};

		pool = { address: '0xpool' };

		buildManagedAccounts() {
			return {
				accountA: {
					key: 'accountA',
					label: 'Account A',
					address: '0xA',
					signer: {}
				},
				accountB: {
					key: 'accountB',
					label: 'Account B',
					address: '0xB',
					signer: {}
				}
			};
		}

		async ensureMarginManager(account: Record<string, unknown>) {
			const key = account.key as 'accountA' | 'accountB';
			return {
				...account,
				marginManagerId: runtimeMockState.managerStates[key].managerId,
				balanceManagerId: runtimeMockState.managerStates[key].balanceManagerId
			};
		}

		async getLivePriceQuote() {
			return {
				price: runtimeMockState.referencePrice,
				source: 'static' as const
			};
		}

		async getWalletBalances() {
			runtimeMockState.getWalletBalancesCallCount += 1;
			const next = runtimeMockState.balanceResponses.shift();
			if (next) {
				runtimeMockState.currentBalances = next;
			}
			return runtimeMockState.currentBalances;
		}

		async listOwnedPoolMarginManagers(account: Record<string, unknown>) {
			const key = account.key as 'accountA' | 'accountB';
			return [
				{
					managerId: runtimeMockState.managerStates[key].managerId,
					balanceManagerId: runtimeMockState.managerStates[key].balanceManagerId
				}
			];
		}

		async getMarginManagerState(account: Record<string, unknown>) {
			return runtimeMockState.managerStates[account.key as 'accountA' | 'accountB'];
		}

		async getAccountOpenOrders(account: Record<string, unknown>) {
			return runtimeMockState.openOrders[account.key as 'accountA' | 'accountB'];
		}

		async swapExactInWithAggregator(input: {
			account: { key: 'accountA' | 'accountB' };
			amountIn: number;
		}) {
			runtimeMockState.swapCalls.push({
				accountKey: input.account.key,
				amountIn: input.amountIn
			});
			const failure = runtimeMockState.swapFailures[input.account.key];
			if (failure) {
				throw failure;
			}
			return {
				provider: 'test',
				txDigest: `tx-${runtimeMockState.swapCalls.length}`,
				amountIn: input.amountIn,
				amountOut: input.amountIn * 9.5,
				coinTypeIn: this.coins.SUI.type,
				coinTypeOut: this.coins.USDC.type
			};
		}

		async transferUsdcBetweenAccounts(input: {
			from: { key: 'accountA' | 'accountB' };
			to: { key: 'accountA' | 'accountB' };
			amount: number;
		}) {
			runtimeMockState.transferCalls.push({
				from: input.from.key,
				to: input.to.key,
				asset: 'USDC',
				amount: input.amount
			});
			if (runtimeMockState.transferFailure) {
				throw runtimeMockState.transferFailure;
			}
			return {
				txDigest: `transfer-${runtimeMockState.transferCalls.length}`,
				amount: input.amount,
				coinType: this.coins.USDC.type
			};
		}

		async transferSuiBetweenAccounts(input: {
			from: { key: 'accountA' | 'accountB' };
			to: { key: 'accountA' | 'accountB' };
			amount: number;
		}) {
			runtimeMockState.transferCalls.push({
				from: input.from.key,
				to: input.to.key,
				asset: 'SUI',
				amount: input.amount
			});
			if (runtimeMockState.transferFailure) {
				throw runtimeMockState.transferFailure;
			}
			return {
				txDigest: `transfer-sui-${runtimeMockState.transferCalls.length}`,
				amount: input.amount,
				coinType: this.coins.SUI.type
			};
		}
	}

	return { DeepBookService };
});

import { BotRuntime } from './runtime.js';

function makeBalances(input: {
	accountAUsdc: number;
	accountASui: number;
	accountBUsdc: number;
	accountBSui: number;
}): WalletBalances {
	const accountATotalUsdc =
		input.accountAUsdc + input.accountASui * runtimeMockState.referencePrice;
	const accountBTotalUsdc =
		input.accountBUsdc + input.accountBSui * runtimeMockState.referencePrice;
	const updatedAt = new Date(0).toISOString();

	return {
		source: 'wallet',
		accountA: {
			sui: input.accountASui,
			usdc: input.accountAUsdc,
			totalUsdc: accountATotalUsdc,
			updatedAt
		},
		accountB: {
			sui: input.accountBSui,
			usdc: input.accountBUsdc,
			totalUsdc: accountBTotalUsdc,
			updatedAt
		},
		totalUsdc: accountATotalUsdc + accountBTotalUsdc,
		updatedAt
	};
}

function resetMocks() {
	runtimeMockState.logs = [];
	runtimeMockState.nextLogId = 1;
	runtimeMockState.referencePrice = 10;
	runtimeMockState.balanceResponses = [];
	runtimeMockState.currentBalances = createWalletBalances();
	runtimeMockState.swapCalls = [];
	runtimeMockState.swapFailures = {};
	runtimeMockState.transferCalls = [];
	runtimeMockState.transferFailure = null;
	runtimeMockState.managerStates = {
		accountA: {
			managerId: 'accountA-mm',
			balanceManagerId: 'accountA-bm',
			baseAsset: 0,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 10
		},
		accountB: {
			managerId: 'accountB-mm',
			balanceManagerId: 'accountB-bm',
			baseAsset: 0,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 10
		}
	};
	runtimeMockState.openOrders = {
		accountA: [],
		accountB: []
	};
	runtimeMockState.getWalletBalancesCallCount = 0;
}

async function createRuntime() {
	const runtime = new BotRuntime();
	await runtime.ensureBooted();
	return runtime;
}

describe('BotRuntime.runAutoBalance', () => {
	beforeEach(() => {
		resetMocks();
		vi.restoreAllMocks();
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('executes swaps only for planned accounts', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 10, accountASui: 20, accountBUsdc: 10, accountBSui: 50 }),
			makeBalances({ accountAUsdc: 10, accountASui: 20, accountBUsdc: 10, accountBSui: 50 }),
			makeBalances({ accountAUsdc: 10, accountASui: 20, accountBUsdc: 220, accountBSui: 28 }),
			makeBalances({ accountAUsdc: 10, accountASui: 20, accountBUsdc: 220, accountBSui: 28 })
		];
		const runtime = await createRuntime();

		await runtime.runAutoBalance(2);

		expect(runtimeMockState.swapCalls).toEqual([
			expect.objectContaining({ accountKey: 'accountB' })
		]);
		await runtime.shutdown();
	});

	it('refreshes wallet balances after each successful swap', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 150, accountASui: 1.2, accountBUsdc: 10, accountBSui: 50 }),
			makeBalances({ accountAUsdc: 150, accountASui: 1.2, accountBUsdc: 10, accountBSui: 50 }),
			makeBalances({ accountAUsdc: 40, accountASui: 15, accountBUsdc: 10, accountBSui: 50 }),
			makeBalances({ accountAUsdc: 40, accountASui: 15, accountBUsdc: 220, accountBSui: 28 }),
			makeBalances({ accountAUsdc: 40, accountASui: 15, accountBUsdc: 220, accountBSui: 28 }),
			makeBalances({ accountAUsdc: 40, accountASui: 15, accountBUsdc: 220, accountBSui: 28 })
		];
		const runtime = await createRuntime();

		await runtime.runAutoBalance(2);

		expect(runtimeMockState.swapCalls).toHaveLength(2);
		expect(runtimeMockState.getWalletBalancesCallCount).toBe(5);
		await runtime.shutdown();
	});

	it('logs an error and rethrows when a swap fails', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 150, accountASui: 1.2, accountBUsdc: 500, accountBSui: 10 })
		];
		runtimeMockState.swapFailures.accountA = new Error('aggregator timeout');
		const runtime = await createRuntime();

		await expect(runtime.runAutoBalance(2)).rejects.toThrow('aggregator timeout');
		expect(
			runtime
				.getSnapshot()
				.logs.some((entry) => entry.message.includes('swap failed for Account A'))
		).toBe(true);
		await runtime.shutdown();
	});

	it('returns current snapshot and performs no swaps when both accounts are already ready', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 10, accountASui: 20, accountBUsdc: 500, accountBSui: 10 }),
			makeBalances({ accountAUsdc: 10, accountASui: 20, accountBUsdc: 500, accountBSui: 10 })
		];
		const runtime = await createRuntime();

		const snapshot = await runtime.runAutoBalance(2);

		expect(runtimeMockState.swapCalls).toHaveLength(0);
		expect(snapshot).toEqual(runtime.getSnapshot());
		await runtime.shutdown();
	});

	it('rejects when preview cannot execute because manager cleanup is required', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 10, accountASui: 50, accountBUsdc: 10, accountBSui: 50 })
		];
		runtimeMockState.openOrders.accountA = [{ orderId: '1' }];
		const runtime = await createRuntime();

		await expect(runtime.runAutoBalance(2)).rejects.toThrow('Account A');
		expect(runtimeMockState.swapCalls).toHaveLength(0);
		await runtime.shutdown();
	});

	it('rejects when preview cannot execute because an account lacks source asset for the swap', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 1, accountASui: 1.1, accountBUsdc: 0, accountBSui: 10 })
		];
		const runtime = await createRuntime();

		await expect(runtime.runAutoBalance(2)).rejects.toThrow('not enough USDC');
		expect(runtimeMockState.swapCalls).toHaveLength(0);
		expect(runtimeMockState.transferCalls).toHaveLength(0);
		await runtime.shutdown();
	});

	it('shares USDC between accounts before swaps when sharing satisfies funding requirements', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 150, accountASui: 30, accountBUsdc: 20, accountBSui: 0.2 }),
			makeBalances({ accountAUsdc: 150, accountASui: 30, accountBUsdc: 20, accountBSui: 0.2 }),
			makeBalances({ accountAUsdc: 54.225, accountASui: 30, accountBUsdc: 115.775, accountBSui: 0.2 }),
			makeBalances({ accountAUsdc: 54.225, accountASui: 30, accountBUsdc: 115.775, accountBSui: 0.2 })
		];
		const runtime = await createRuntime();

		await runtime.runAutoBalance(2);

		expect(runtimeMockState.transferCalls).toHaveLength(1);
		expect(runtimeMockState.transferCalls[0]).toEqual(
			expect.objectContaining({ from: 'accountA', to: 'accountB', asset: 'USDC' })
		);
		expect(runtimeMockState.swapCalls).toHaveLength(0);
		await runtime.shutdown();
	});

	it('shares SUI between accounts before swaps when SUI sharing satisfies funding requirements', async () => {
		runtimeMockState.balanceResponses = [
			makeBalances({ accountAUsdc: 1, accountASui: 1.2, accountBUsdc: 0, accountBSui: 40 }),
			makeBalances({ accountAUsdc: 1, accountASui: 1.2, accountBUsdc: 0, accountBSui: 40 }),
			makeBalances({ accountAUsdc: 1, accountASui: 12.5775, accountBUsdc: 0, accountBSui: 28.6225 }),
			makeBalances({ accountAUsdc: 1, accountASui: 12.5775, accountBUsdc: 0, accountBSui: 28.6225 }),
			makeBalances({ accountAUsdc: 1, accountASui: 12.5775, accountBUsdc: 130, accountBSui: 15 }),
			makeBalances({ accountAUsdc: 1, accountASui: 12.5775, accountBUsdc: 130, accountBSui: 15 }),
			makeBalances({ accountAUsdc: 1, accountASui: 12.5775, accountBUsdc: 130, accountBSui: 15 })
		];
		const runtime = await createRuntime();

		await runtime.runAutoBalance(2);

		expect(runtimeMockState.transferCalls).toHaveLength(1);
		expect(runtimeMockState.transferCalls[0]).toEqual(
			expect.objectContaining({ from: 'accountB', to: 'accountA', asset: 'SUI' })
		);
		expect(runtimeMockState.swapCalls).toEqual([
			expect.objectContaining({ accountKey: 'accountB' })
		]);
		await runtime.shutdown();
	});

});
