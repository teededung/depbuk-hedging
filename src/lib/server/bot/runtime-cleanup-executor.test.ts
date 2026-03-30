import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeCleanupExecutor, classifyCleanupStrategy } from './runtime-cleanup-executor.js';
import { managerNeedsCleanup } from './runtime-snapshot.js';
import type {
	ManagedAccount,
	RuntimeCleanupContext,
	StartAccountState
} from './runtime-context.js';
import type { RuntimeSnapshot } from './types.js';

function createManagedAccount(key: 'accountA' | 'accountB'): ManagedAccount {
	return {
		key,
		label: key === 'accountA' ? 'Account A' : 'Account B',
		address: `0x${key}`,
		marginManagerId: `manager-${key}`,
		signer: {} as never
	};
}

function flatState(managerId: string): StartAccountState {
	return {
		managerId,
		openOrdersCount: 0,
		baseAsset: 0,
		quoteAsset: 0,
		baseDebt: 0,
		quoteDebt: 0,
		isBlocked: false
	};
}

function dirtyState(managerId: string, overrides: Partial<StartAccountState>): StartAccountState {
	return { ...flatState(managerId), ...overrides };
}

function createSnapshot(): RuntimeSnapshot {
	return {
		lifecycle: 'STOPPED',
		liveLabel: 'Offline',
		runLabel: 'STOPPED',
		message: '',
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
			plannedNotionalUsd: 0,
			estimatedQuantitySui: 0,
			configuredNotionalUsd: 0,
			minNotionalUsd: 0,
			effectiveNotionalUsd: 0,
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
		autoTopup: { status: 'idle', account: null, updatedAt: new Date().toISOString() },
		activeCycle: null,
		history: [],
		logs: [],
		config: null,
		updatedAt: new Date().toISOString()
	};
}

function createContext(overrides?: {
	service?: Record<string, unknown>;
	snapshot?: RuntimeSnapshot;
	inspectState?: StartAccountState | null;
	inspectStateSequence?: (StartAccountState | null)[];
	withRetry?: RuntimeCleanupContext['withRetry'];
}) {
	const snapshot = overrides?.snapshot ?? createSnapshot();
	const logs: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
	const accountA = createManagedAccount('accountA');
	const accountB = createManagedAccount('accountB');
	let cleanupInProgress = false;

	const db = {
		listRecentCycles: vi.fn().mockResolvedValue(snapshot.history),
		appendRecoveryEvent: vi.fn().mockResolvedValue(undefined),
		clearAllData: vi.fn().mockResolvedValue(undefined)
	};

	const service: Record<string, ReturnType<typeof vi.fn>> = {
		cancelAllConditionalOrders: vi.fn().mockResolvedValue(undefined),
		cancelAllOrders: vi.fn().mockResolvedValue(undefined),
		withdrawSettled: vi.fn().mockResolvedValue(undefined),
		getMarginManagerState: vi.fn().mockResolvedValue(null),
		repayAndWithdrawAll: vi.fn().mockResolvedValue(undefined),
		compactCleanupWithdraw: vi.fn().mockResolvedValue(undefined),
		placeLongCloseMarketOrderAndRepayQuote: vi.fn().mockResolvedValue(null),
		placeShortCloseMarketOrderAndRepayBase: vi.fn().mockResolvedValue(null),
		...overrides?.service
	};

	let inspectCallCount = 0;
	const inspectMock = vi.fn().mockImplementation(async () => {
		if (overrides?.inspectStateSequence) {
			const state = overrides.inspectStateSequence[inspectCallCount] ?? null;
			inspectCallCount++;
			if (state === null) throw new Error('inspect failed');
			return state;
		}
		const state = overrides?.inspectState ?? flatState(accountA.marginManagerId!);
		if (state === null) throw new Error('inspect failed');
		return state;
	});

	const context: RuntimeCleanupContext = {
		getService: () => service as never,
		getAccounts: () => ({ accountA, accountB }),
		getDb: () => db as never,
		getSnapshot: () => snapshot,
		appendLog: async (level, message, meta) => {
			logs.push({ level, message, meta });
		},
		withRetry: overrides?.withRetry ?? (async (_label, fn) => fn()),
		inspectManagedAccountState: inspectMock,
		managerNeedsCleanup,
		resolveCleanupManagedAccounts: vi.fn().mockImplementation(async (account: ManagedAccount) => ({
			managedAccounts: [account],
			source: 'chain',
			totalKnown: 1
		})),
		cacheManagedAccountState: vi.fn(),
		getCleanupInProgress: () => cleanupInProgress,
		setCleanupInProgress: (value) => {
			cleanupInProgress = value;
		},
		clientOrderId: () => 'cleanup-client-order',
		normalizeCleanupQuantity: (quantity, lotSize, minSize) => {
			const size = Math.floor(quantity / lotSize) * lotSize;
			return size >= minSize ? size : null;
		}
	};

	return { context, logs, db, service, accountA, accountB, inspectMock };
}

// ─── classifyCleanupStrategy ────────────────────────────────────────────

describe('classifyCleanupStrategy', () => {
	it('returns already_flat when all values are zero', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 0, quoteAsset: 0, baseDebt: 0, quoteDebt: 0 })
		).toBe('already_flat');
	});

	it('returns already_flat when all values are below dust thresholds', () => {
		expect(
			classifyCleanupStrategy({
				baseAsset: 0.000005,
				quoteAsset: 0.005,
				baseDebt: 0.000005,
				quoteDebt: 0.005
			})
		).toBe('already_flat');
	});

	it('returns long_debt_close when quoteDebt and baseAsset are present', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 10, quoteAsset: 0, baseDebt: 0, quoteDebt: 50 })
		).toBe('long_debt_close');
	});

	it('returns short_debt_close when baseDebt and quoteAsset are present', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 0, quoteAsset: 100, baseDebt: 5, quoteDebt: 0 })
		).toBe('short_debt_close');
	});

	it('returns asset_only_withdraw when no debt but residual assets remain', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 1.5, quoteAsset: 0, baseDebt: 0, quoteDebt: 0 })
		).toBe('asset_only_withdraw');
	});

	it('returns asset_only_withdraw for quote-only residual', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 0, quoteAsset: 25, baseDebt: 0, quoteDebt: 0 })
		).toBe('asset_only_withdraw');
	});

	it('returns dust_repay_withdraw when baseDebt exists without matching quoteAsset', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 0, quoteAsset: 0, baseDebt: 0.5, quoteDebt: 0 })
		).toBe('dust_repay_withdraw');
	});

	it('returns dust_repay_withdraw when quoteDebt exists without matching baseAsset', () => {
		expect(
			classifyCleanupStrategy({ baseAsset: 0, quoteAsset: 0, baseDebt: 0, quoteDebt: 5 })
		).toBe('dust_repay_withdraw');
	});

	it('prefers long_debt_close over short_debt_close when both debts and assets exist', () => {
		// Both debts and both assets — quoteDebt + baseAsset check comes first
		expect(
			classifyCleanupStrategy({ baseAsset: 10, quoteAsset: 100, baseDebt: 5, quoteDebt: 50 })
		).toBe('long_debt_close');
	});
});

// ─── flattenSingleManager ───────────────────────────────────────────────

describe('flattenSingleManager', () => {
	it('short_debt_close: exits after primary PTB when verification shows flat', async () => {
		const shortDebtState = dirtyState('manager-accountB', {
			baseDebt: 5,
			quoteAsset: 100,
			currentPrice: 3.5
		} as Partial<StartAccountState> & { currentPrice: number });

		const { context, service, accountB, logs } = createContext({
			inspectStateSequence: [
				// Step 4 verify after primary → flat
				flatState('manager-accountB')
			],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue({
					...shortDebtState,
					currentPrice: 3.5
				}),
				placeShortCloseMarketOrderAndRepayBase: vi.fn().mockResolvedValue({
					filledQuantity: 5,
					averageFillPrice: 3.5,
					txDigest: '0xshortclose',
					gasUsedSui: 0.01
				})
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountB, errors);

		expect(errors).toHaveLength(0);
		expect(service.placeShortCloseMarketOrderAndRepayBase).toHaveBeenCalledOnce();
		// Should NOT fall through to secondary
		expect(service.compactCleanupWithdraw).not.toHaveBeenCalled();
		expect(service.repayAndWithdrawAll).not.toHaveBeenCalled();
		// Strategy log present
		expect(logs.some((l) => l.message.includes('short_debt_close'))).toBe(true);
	});

	it('long_debt_close: records recovery and exits after flat verification', async () => {
		const longDebtState = {
			baseAsset: 10,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 50,
			currentPrice: 3.5
		};

		const snapshot = createSnapshot();
		snapshot.history = [
			{
				id: 1,
				cycleNumber: 42,
				status: 'open',
				accountAManagerId: 'manager-accountA',
				accountBManagerId: 'manager-accountB',
				orders: [
					{
						account: 'accountA',
						side: 'LONG',
						phase: 'OPEN',
						orderId: 'order-1',
						txDigest: '0xopen',
						filledPrice: 3.0,
						filledQuantity: 10,
						price: 3.0,
						quantity: 10,
						status: 'filled'
					}
				],
				startedAt: new Date().toISOString(),
				completedAt: null,
				pnlUsd: null,
				gasUsd: null,
				feesUsd: null,
				volumeUsd: null
			} as never
		];

		const { context, service, accountA, db } = createContext({
			snapshot,
			inspectStateSequence: [flatState('manager-accountA')],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(longDebtState),
				placeLongCloseMarketOrderAndRepayQuote: vi.fn().mockResolvedValue({
					filledQuantity: 10,
					averageFillPrice: 3.5,
					txDigest: '0xlongclose',
					gasUsedSui: 0.02
				})
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		const result = await executor.flattenSingleManager(accountA, errors, 'run-1');

		expect(errors).toHaveLength(0);
		expect(service.placeLongCloseMarketOrderAndRepayQuote).toHaveBeenCalledOnce();
		expect(db.appendRecoveryEvent).toHaveBeenCalledOnce();
		expect(result.count).toBe(1);
		expect(result.pnlUsd).toBeGreaterThan(0); // bought at 3.0, sold at 3.5
	});

	it('flat manager after primary PTB failure reports success if verification shows flat', async () => {
		const shortDebtState = {
			baseDebt: 5,
			quoteAsset: 100,
			currentPrice: 3.5
		};

		const { context, service, accountB } = createContext({
			inspectStateSequence: [
				// Verify after primary → flat despite PTB failure
				flatState('manager-accountB')
			],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(shortDebtState),
				placeShortCloseMarketOrderAndRepayBase: vi
					.fn()
					.mockRejectedValue(new Error('PTB execution failed'))
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountB, errors);

		// Even though PTB failed, verification showed flat → no errors propagated
		expect(errors).toHaveLength(0);
		expect(service.compactCleanupWithdraw).not.toHaveBeenCalled();
		expect(service.repayAndWithdrawAll).not.toHaveBeenCalled();
	});

	it('marks dedicated short close PTB retry failures as recoverable-warning logs', async () => {
		const shortDebtState = {
			baseDebt: 5,
			quoteAsset: 100,
			currentPrice: 3.5
		};
		const withRetry = vi.fn().mockImplementation(async (label, fn, _maxAttempts, meta, options) => {
			if (label === 'run dedicated short close market repay PTB') {
				expect(meta).not.toHaveProperty('__finalFailureLevel');
				expect(options).toMatchObject({ finalFailureLevel: 'warn' });
				throw new Error('Margin funding not available yet.');
			}
			return fn();
		});

		const { context, accountB } = createContext({
			withRetry,
			inspectStateSequence: [
				// Verify after primary PTB failure still reports flat.
				flatState('manager-accountB')
			],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(shortDebtState)
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountB, errors);

		expect(errors).toHaveLength(0);
	});

	it('asset_only_withdraw: uses compactCleanupWithdraw only', async () => {
		const assetOnlyState = {
			baseAsset: 2.5,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 0,
			currentPrice: 3.5
		};

		const { context, service, accountA } = createContext({
			inspectStateSequence: [flatState('manager-accountA')],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(assetOnlyState)
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountA, errors);

		expect(errors).toHaveLength(0);
		expect(service.compactCleanupWithdraw).toHaveBeenCalledOnce();
		expect(service.placeShortCloseMarketOrderAndRepayBase).not.toHaveBeenCalled();
		expect(service.placeLongCloseMarketOrderAndRepayQuote).not.toHaveBeenCalled();
	});

	it('dust_repay_withdraw: uses repayAndWithdrawAll for sub-minSize debt', async () => {
		const dustDebtState = {
			baseAsset: 0,
			quoteAsset: 0,
			baseDebt: 0.0005,
			quoteDebt: 0,
			currentPrice: 3.5
		};

		const { context, service, accountB } = createContext({
			inspectStateSequence: [flatState('manager-accountB')],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(dustDebtState)
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountB, errors);

		expect(errors).toHaveLength(0);
		expect(service.repayAndWithdrawAll).toHaveBeenCalledOnce();
		expect(service.compactCleanupWithdraw).not.toHaveBeenCalled();
	});

	it('secondary strategy runs when primary leaves residual assets', async () => {
		const shortDebtState = {
			baseDebt: 5,
			quoteAsset: 100,
			currentPrice: 3.5
		};

		// After primary short close, residual quote asset remains (no debt)
		const residualState = dirtyState('manager-accountB', {
			quoteAsset: 2.5,
			baseDebt: 0,
			quoteDebt: 0,
			blockingReason: '2.5 USDC asset still in margin'
		});

		const { context, service, accountB, logs } = createContext({
			inspectStateSequence: [
				// Step 4 verify after primary → still has residual
				residualState,
				// Step 5 verify after secondary → flat
				flatState('manager-accountB')
			],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(shortDebtState),
				placeShortCloseMarketOrderAndRepayBase: vi.fn().mockResolvedValue({
					filledQuantity: 5,
					averageFillPrice: 3.5,
					txDigest: '0xshortclose'
				})
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountB, errors);

		expect(errors).toHaveLength(0);
		expect(service.placeShortCloseMarketOrderAndRepayBase).toHaveBeenCalledOnce();
		// Secondary should use compactCleanupWithdraw for asset_only_withdraw
		expect(service.compactCleanupWithdraw).toHaveBeenCalledOnce();
		// Should log secondary strategy
		expect(logs.some((l) => l.message.includes('secondary strategy'))).toBe(true);
	});

	it('secondary strategy uses repayAndWithdrawAll for residual dust debt', async () => {
		const longDebtState = {
			baseAsset: 10,
			quoteAsset: 0,
			baseDebt: 0,
			quoteDebt: 50,
			currentPrice: 3.5
		};

		// After primary long close, tiny quote debt remains
		const residualState = dirtyState('manager-accountA', {
			quoteDebt: 0.05,
			baseAsset: 0,
			quoteAsset: 0,
			blockingReason: '0.05 USDC debt still open'
		});

		const { context, service, accountA } = createContext({
			inspectStateSequence: [residualState, flatState('manager-accountA')],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(longDebtState),
				placeLongCloseMarketOrderAndRepayQuote: vi.fn().mockResolvedValue({
					filledQuantity: 10,
					averageFillPrice: 3.5,
					txDigest: '0xlongclose'
				})
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountA, errors);

		expect(errors).toHaveLength(0);
		// Secondary should use repayAndWithdrawAll for dust_repay_withdraw
		expect(service.repayAndWithdrawAll).toHaveBeenCalledOnce();
	});

	it('already_flat strategy skips all PTBs', async () => {
		const { context, service, accountA, logs } = createContext({
			inspectStateSequence: [flatState('manager-accountA')],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue({
					baseAsset: 0,
					quoteAsset: 0,
					baseDebt: 0,
					quoteDebt: 0,
					currentPrice: 3.5
				})
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountA, errors);

		expect(errors).toHaveLength(0);
		expect(service.placeShortCloseMarketOrderAndRepayBase).not.toHaveBeenCalled();
		expect(service.placeLongCloseMarketOrderAndRepayQuote).not.toHaveBeenCalled();
		expect(service.compactCleanupWithdraw).not.toHaveBeenCalled();
		expect(service.repayAndWithdrawAll).not.toHaveBeenCalled();
		expect(logs.some((l) => l.message.includes('already_flat'))).toBe(true);
	});

	it('falls back to repayAndWithdrawAll when state cannot be loaded', async () => {
		const { context, service, accountA } = createContext({
			inspectStateSequence: [flatState('manager-accountA')],
			service: {
				getMarginManagerState: vi.fn().mockRejectedValue(new Error('RPC error'))
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountA, errors);

		expect(service.repayAndWithdrawAll).toHaveBeenCalledOnce();
		expect(service.placeShortCloseMarketOrderAndRepayBase).not.toHaveBeenCalled();
		expect(service.placeLongCloseMarketOrderAndRepayQuote).not.toHaveBeenCalled();
	});

	it('propagates errors when cleanup truly fails after secondary', async () => {
		const shortDebtState = {
			baseDebt: 5,
			quoteAsset: 100,
			currentPrice: 3.5
		};

		const stillDirty = dirtyState('manager-accountB', {
			baseDebt: 5,
			quoteAsset: 50,
			blockingReason: '5 SUI debt still open'
		});

		const { context, service, accountB } = createContext({
			inspectStateSequence: [
				// After primary → still dirty
				stillDirty,
				// After secondary → still dirty
				stillDirty
			],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue(shortDebtState),
				placeShortCloseMarketOrderAndRepayBase: vi.fn().mockRejectedValue(new Error('PTB failed'))
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		const errors: string[] = [];
		await executor.flattenSingleManager(accountB, errors);

		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('cleanup failed'))).toBe(true);
	});
});

// ─── forceFlatten ───────────────────────────────────────────────────────

describe('forceFlatten', () => {
	it('skips already-flat managers without calling any service PTBs', async () => {
		const { context, service } = createContext({
			inspectState: flatState('manager-accountA')
		});

		const executor = new RuntimeCleanupExecutor(context);
		await executor.forceFlatten(false);

		expect(service.placeShortCloseMarketOrderAndRepayBase).not.toHaveBeenCalled();
		expect(service.placeLongCloseMarketOrderAndRepayQuote).not.toHaveBeenCalled();
		expect(service.compactCleanupWithdraw).not.toHaveBeenCalled();
		expect(service.repayAndWithdrawAll).not.toHaveBeenCalled();
	});

	it('clears data when clearData is true and cleanup succeeds', async () => {
		const { context, db } = createContext({
			inspectState: flatState('manager-accountA')
		});

		const executor = new RuntimeCleanupExecutor(context);
		await executor.forceFlatten(true);

		expect(db.clearAllData).toHaveBeenCalledOnce();
	});

	it('does not clear data when clearData is false', async () => {
		const { context, db } = createContext({
			inspectState: flatState('manager-accountA')
		});

		const executor = new RuntimeCleanupExecutor(context);
		await executor.forceFlatten(false);

		expect(db.clearAllData).not.toHaveBeenCalled();
	});

	it('throws when cleanup fails for a manager', async () => {
		const stillDirty = dirtyState('manager-accountA', {
			baseDebt: 5,
			quoteAsset: 100,
			blockingReason: '5 SUI debt still open'
		});

		const { context } = createContext({
			inspectStateSequence: [
				// inspectManagedAccountState for discovery → dirty
				stillDirty,
				// getMarginManagerState returns state for classify
				// inspectManagedAccountState after primary → still dirty
				stillDirty,
				// inspectManagedAccountState after secondary → still dirty
				stillDirty
			],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue({
					baseDebt: 5,
					quoteAsset: 100,
					currentPrice: 3.5
				}),
				placeShortCloseMarketOrderAndRepayBase: vi.fn().mockRejectedValue(new Error('PTB failed'))
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		await expect(executor.forceFlatten(false)).rejects.toThrow('Forced cleanup failed');
	});

	it('restores cleanupInProgress flag even on failure', async () => {
		const stillDirty = dirtyState('manager-accountA', {
			baseDebt: 5,
			quoteAsset: 100,
			blockingReason: '5 SUI debt still open'
		});

		const { context } = createContext({
			inspectStateSequence: [stillDirty, stillDirty, stillDirty],
			service: {
				getMarginManagerState: vi.fn().mockResolvedValue({
					baseDebt: 5,
					quoteAsset: 100,
					currentPrice: 3.5
				}),
				placeShortCloseMarketOrderAndRepayBase: vi.fn().mockRejectedValue(new Error('PTB failed'))
			}
		});

		const executor = new RuntimeCleanupExecutor(context);
		expect(context.getCleanupInProgress()).toBe(false);
		await executor.forceFlatten(false).catch(() => {});
		expect(context.getCleanupInProgress()).toBe(false);
	});
});
