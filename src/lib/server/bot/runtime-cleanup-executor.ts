import type {
	ManagedAccount,
	RuntimeCleanupContext,
	StartAccountState
} from './runtime-context.js';
import type { CycleHistoryRecord } from './types.js';
import { isRateLimitedErrorMessage, mapWithConcurrency, nowIso, round } from './runtime-shared.js';

export type CleanupStrategy =
	| 'already_flat'
	| 'long_debt_close'
	| 'short_debt_close'
	| 'asset_only_withdraw'
	| 'dust_repay_withdraw';

const BASE_DEBT_DUST = 0.00001;
const QUOTE_DEBT_DUST = 0.01;

export function classifyCleanupStrategy(state: {
	baseAsset: number;
	quoteAsset: number;
	baseDebt: number;
	quoteDebt: number;
}): CleanupStrategy {
	const hasBaseDebt = state.baseDebt > BASE_DEBT_DUST;
	const hasQuoteDebt = state.quoteDebt > QUOTE_DEBT_DUST;
	const hasBaseAsset = state.baseAsset > BASE_DEBT_DUST;
	const hasQuoteAsset = state.quoteAsset > QUOTE_DEBT_DUST;

	// No meaningful debt and no meaningful assets → flat
	if (!hasBaseDebt && !hasQuoteDebt && !hasBaseAsset && !hasQuoteAsset) {
		return 'already_flat';
	}

	// Long debt: quoteDebt with baseAsset to sell
	if (hasQuoteDebt && hasBaseAsset) {
		return 'long_debt_close';
	}

	// Short debt: baseDebt with quoteAsset to buy
	if (hasBaseDebt && hasQuoteAsset) {
		return 'short_debt_close';
	}

	// Debt remains but no matching asset to close with → dust repay from wallet
	if (hasBaseDebt || hasQuoteDebt) {
		return 'dust_repay_withdraw';
	}

	// No debt, just residual assets
	return 'asset_only_withdraw';
}

export class RuntimeCleanupExecutor {
	#ctx: RuntimeCleanupContext;

	constructor(ctx: RuntimeCleanupContext) {
		this.#ctx = ctx;
	}

	async cleanupAccounts(): Promise<void> {
		const service = this.#ctx.getService();
		const accounts = this.#ctx.getAccounts();
		if (!accounts) {
			return;
		}

		const cleanupAccount = async (account: ManagedAccount) => {
			const meta = { account: account.label, phase: 'CLOSE' as const };
			let state = await this.#ctx.inspectManagedAccountState(account).catch(() => null);

			if (!state) {
				await this.#ctx
					.withRetry(
						'repay and withdraw residual balances after cycle close',
						() => service.repayAndWithdrawAll(account),
						3,
						meta
					)
					.catch(() => {});
				return;
			}

			if (!this.#ctx.managerNeedsCleanup(state)) {
				await this.#ctx.appendLog(
					'info',
					`Post-cycle cleanup skipped for ${account.label}; manager already flat.`,
					meta
				);
				return;
			}

			if (state.openOrdersCount > 0) {
				await this.#ctx
					.withRetry(
						'cancel all open orders after cycle close',
						() => service.cancelAllOrders(account),
						3,
						meta
					)
					.catch(() => {});
				await this.#ctx
					.withRetry(
						'withdraw settled amounts after cycle close',
						() => service.withdrawSettled(account),
						3,
						meta
					)
					.catch(() => {});
				state = await this.#ctx.inspectManagedAccountState(account).catch(() => state);
			}

			if (state && !this.#ctx.managerNeedsCleanup(state)) {
				await this.#ctx.appendLog(
					'info',
					`Post-cycle cleanup finished for ${account.label}.`,
					meta
				);
				return;
			}

			await this.#ctx
				.withRetry(
					'repay and withdraw residual balances after cycle close',
					() => service.repayAndWithdrawAll(account),
					3,
					meta
				)
				.catch(() => {});
		};

		await Promise.all([cleanupAccount(accounts.accountA), cleanupAccount(accounts.accountB)]);
	}

	async lookupCleanupEntryBasis(
		account: ManagedAccount,
		side: 'LONG' | 'SHORT'
	): Promise<{ cycleNumber: number | null; entryPrice: number | null }> {
		const db = this.#ctx.getDb();
		const snapshot = this.#ctx.getSnapshot();
		const history: CycleHistoryRecord[] =
			snapshot.history.length > 0 ? snapshot.history : db ? await db.listRecentCycles(24) : [];

		for (const cycle of history) {
			if (cycle.status === 'completed') {
				continue;
			}

			const managerId =
				account.key === 'accountA' ? cycle.accountAManagerId : cycle.accountBManagerId;
			if (managerId && account.marginManagerId && managerId !== account.marginManagerId) {
				continue;
			}

			const matchingOrder = cycle.orders.find(
				(order) =>
					order.account === account.key &&
					order.side === side &&
					order.phase === 'OPEN' &&
					(order.orderId || order.txDigest || (order.filledQuantity ?? 0) > 0)
			);
			if (matchingOrder) {
				return {
					cycleNumber: cycle.cycleNumber,
					entryPrice: matchingOrder.filledPrice ?? matchingOrder.price
				};
			}
		}

		return {
			cycleNumber: null,
			entryPrice: null
		};
	}

	async recordCleanupRecovery(input: {
		cleanupRunId: string | null;
		account: ManagedAccount;
		side: 'LONG' | 'SHORT';
		quantity: number;
		exitPrice: number;
		txDigest?: string;
		gasUsedSui?: number;
	}): Promise<{ count: number; pnlUsd: number; gasUsd: number } | null> {
		const db = this.#ctx.getDb();
		if (!db || !input.cleanupRunId || input.quantity <= 0 || input.exitPrice <= 0) {
			return null;
		}

		const basis = await this.lookupCleanupEntryBasis(input.account, input.side);
		if (!basis.entryPrice || basis.entryPrice <= 0) {
			await this.#ctx.appendLog(
				'warn',
				`Cleanup ${input.side.toLowerCase()} recovery filled without a known entry price.`,
				{
					account: input.account.label,
					accountKey: input.account.key,
					side: input.side,
					phase: 'CLOSE',
					cleanupRunId: input.cleanupRunId,
					quantity: round(input.quantity, 9),
					exitPrice: round(input.exitPrice, 6),
					txDigest: input.txDigest
				}
			);
			return null;
		}

		const gasUsd = round((input.gasUsedSui ?? 0) * input.exitPrice, 6);
		const tradePnlUsd = round(
			input.side === 'LONG'
				? input.quantity * (input.exitPrice - basis.entryPrice)
				: input.quantity * (basis.entryPrice - input.exitPrice),
			6
		);
		const pnlUsd = round(tradePnlUsd - gasUsd, 6);

		await db.appendRecoveryEvent({
			cleanupRunId: input.cleanupRunId,
			accountKey: input.account.key,
			managerId: input.account.marginManagerId,
			side: input.side,
			cycleNumber: basis.cycleNumber,
			quantity: round(input.quantity, 9),
			entryPrice: round(basis.entryPrice, 6),
			exitPrice: round(input.exitPrice, 6),
			pnlUsd,
			gasUsd,
			txDigest: input.txDigest,
			note: `Cleanup recovery for ${input.account.label}`
		});

		await this.#ctx.appendLog('success', `Cleanup ${input.side.toLowerCase()} recovery recorded.`, {
			account: input.account.label,
			accountKey: input.account.key,
			side: input.side,
			phase: 'CLOSE',
			cleanupRunId: input.cleanupRunId,
			cycleNumber: basis.cycleNumber,
			quantity: round(input.quantity, 9),
			entryPrice: round(basis.entryPrice, 6),
			exitPrice: round(input.exitPrice, 6),
			pnlUsd,
			gasUsd,
			txDigest: input.txDigest
		});
		return {
			count: 1,
			pnlUsd,
			gasUsd
		};
	}

	async flattenSingleManager(
		account: ManagedAccount,
		errors: string[],
		cleanupRunId: string | null = null
	): Promise<{ count: number; pnlUsd: number; gasUsd: number }> {
		const service = this.#ctx.getService();
		const accounts = this.#ctx.getAccounts();
		const recoverySummary = { count: 0, pnlUsd: 0, gasUsd: 0 };
		const meta = {
			account: account.label,
			accountKey: account.key,
			managerId: account.marginManagerId,
			phase: 'CLOSE' as const,
			cleanupRunId
		};
		const currentManagerId = accounts?.[account.key]?.marginManagerId;
		if (account.marginManagerId && account.marginManagerId !== currentManagerId) {
			await this.#ctx.appendLog('info', `Flattening extra margin manager for ${account.label}.`, {
				...meta,
				currentManagerId
			});
		}

		const managerErrors: string[] = [];
		const recordFailure = (step: string, error: unknown): void => {
			const message = error instanceof Error ? error.message : String(error);
			managerErrors.push(
				`${account.label} ${account.marginManagerId ?? 'unknown'} ${step}: ${message}`
			);
		};

		const cacheAndReturnIfFlat = async (
			candidateState: StartAccountState | null
		): Promise<boolean> => {
			if (!candidateState) {
				return false;
			}
			await this.#ctx.cacheManagedAccountState(account, candidateState, {
				lastCleanupAt: nowIso(),
				lastCleanupError: candidateState.blockingReason ?? null
			});
			if (candidateState.blockingReason) {
				return false;
			}
			if (managerErrors.length > 0) {
				await this.#ctx.appendLog(
					'info',
					`Cleanup finished with recoverable intermediate errors for ${account.label}. Final manager state is flat.`,
					{ ...meta, recoveredErrors: managerErrors.length }
				);
			}
			return true;
		};

		// ── Step 1: Cancel orders and settle ──
		await this.#ctx
			.withRetry(
				'cancel conditional orders',
				() => service.cancelAllConditionalOrders(account),
				3,
				meta
			)
			.catch((error) => recordFailure('cancel conditional orders', error));

		await this.#ctx
			.withRetry(
				'cancel all open orders before forced cleanup',
				() => service.cancelAllOrders(account),
				3,
				meta
			)
			.catch((error) => recordFailure('cancel all open orders', error));

		await this.#ctx
			.withRetry(
				'withdraw settled amounts before forced cleanup',
				() => service.withdrawSettled(account),
				3,
				meta
			)
			.catch((error) => recordFailure('withdraw settled amounts', error));

		// ── Step 2: Load state and classify strategy ──
		const state = await this.#ctx
			.withRetry('load margin manager state', () => service.getMarginManagerState(account), 3, meta)
			.catch((error) => {
				recordFailure('load margin manager state', error);
				return null;
			});

		if (!state || !accounts) {
			// Cannot classify — fall back to wallet-assisted repay
			await this.#ctx
				.withRetry(
					'repay and withdraw (no state)',
					() => service.repayAndWithdrawAll(account),
					3,
					meta
				)
				.catch((error) => recordFailure('repay and withdraw (no state)', error));
			const postState = await this.#ctx.inspectManagedAccountState(account).catch(() => null);
			if (await cacheAndReturnIfFlat(postState)) {
				return recoverySummary;
			}
			errors.push(...managerErrors);
			return recoverySummary;
		}

		const strategy = classifyCleanupStrategy(state);
		await this.#ctx.appendLog(
			'info',
			`Cleanup strategy selected for ${account.label}: ${strategy}`,
			{
				...meta,
				strategy,
				baseAsset: round(state.baseAsset, 9),
				quoteAsset: round(state.quoteAsset, 6),
				baseDebt: round(state.baseDebt, 9),
				quoteDebt: round(state.quoteDebt, 6),
				currentPrice: round(state.currentPrice, 6)
			}
		);

		// ── Step 3: Execute primary strategy (PTB 1) ──
		if (strategy === 'already_flat') {
			const postState = await this.#ctx.inspectManagedAccountState(account).catch(() => null);
			await cacheAndReturnIfFlat(postState);
			return recoverySummary;
		}

		if (strategy === 'long_debt_close') {
			const result = await this.#ctx
				.withRetry(
					'run dedicated long close market repay PTB',
					() =>
						service.placeLongCloseMarketOrderAndRepayQuote({
							account,
							clientOrderId: this.#ctx.clientOrderId(),
							targetQuoteDebt: state.quoteDebt,
							maxBaseQuantity: state.baseAsset
						}),
					3,
					{ ...meta },
					{
						finalFailureLevel: 'warn'
					}
				)
				.catch((error) => {
					recordFailure('run dedicated long close market repay PTB', error);
					return null;
				});

			if (result) {
				const recovery = await this.recordCleanupRecovery({
					cleanupRunId,
					account,
					side: 'LONG',
					quantity: round(result.filledQuantity ?? result.computedSellQuantity ?? 0, 9),
					exitPrice: round(result.averageFillPrice ?? state.currentPrice, 6),
					txDigest: result.txDigest,
					gasUsedSui: result.gasUsedSui
				});
				if (recovery) {
					recoverySummary.count += recovery.count;
					recoverySummary.pnlUsd = round(recoverySummary.pnlUsd + recovery.pnlUsd, 6);
					recoverySummary.gasUsd = round(recoverySummary.gasUsd + recovery.gasUsd, 6);
				}
			}
		}

		if (strategy === 'short_debt_close') {
			const result = await this.#ctx
				.withRetry(
					'run dedicated short close market repay PTB',
					() =>
						service.placeShortCloseMarketOrderAndRepayBase({
							account,
							clientOrderId: this.#ctx.clientOrderId(),
							targetBaseDebt: state.baseDebt,
							maxQuoteQuantity: state.quoteAsset
						}),
					3,
					{ ...meta },
					{
						finalFailureLevel: 'warn'
					}
				)
				.catch((error) => {
					recordFailure('run dedicated short close market repay PTB', error);
					return null;
				});

			if (result) {
				const recovery = await this.recordCleanupRecovery({
					cleanupRunId,
					account,
					side: 'SHORT',
					quantity: round(result.filledQuantity ?? result.computedBuyQuantity ?? 0, 9),
					exitPrice: round(result.averageFillPrice ?? state.currentPrice, 6),
					txDigest: result.txDigest,
					gasUsedSui: result.gasUsedSui
				});
				if (recovery) {
					recoverySummary.count += recovery.count;
					recoverySummary.pnlUsd = round(recoverySummary.pnlUsd + recovery.pnlUsd, 6);
					recoverySummary.gasUsd = round(recoverySummary.gasUsd + recovery.gasUsd, 6);
				}
			}
		}

		if (strategy === 'asset_only_withdraw') {
			await this.#ctx
				.withRetry(
					'run compact cleanup withdraw PTB',
					() => service.compactCleanupWithdraw(account),
					3,
					meta
				)
				.catch((error) => recordFailure('run compact cleanup withdraw PTB', error));
		}

		if (strategy === 'dust_repay_withdraw') {
			await this.#ctx
				.withRetry(
					'repay and withdraw dust residual',
					() => service.repayAndWithdrawAll(account),
					3,
					meta
				)
				.catch((error) => recordFailure('repay and withdraw dust residual', error));
		}

		// ── Step 4: Verify after primary strategy ──
		const postPrimaryState = await this.#ctx.inspectManagedAccountState(account).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!isRateLimitedErrorMessage(message)) {
				recordFailure('verify after primary strategy', error);
			}
			return null;
		});

		if (await cacheAndReturnIfFlat(postPrimaryState)) {
			return recoverySummary;
		}

		// ── Step 5: Secondary residual strategy (PTB 2) ──
		const secondaryStrategy = postPrimaryState
			? classifyCleanupStrategy(postPrimaryState)
			: 'dust_repay_withdraw';

		if (secondaryStrategy !== 'already_flat') {
			await this.#ctx.appendLog(
				'info',
				`Cleanup secondary strategy for ${account.label}: ${secondaryStrategy}`,
				{
					...meta,
					secondaryStrategy,
					baseAsset: round(postPrimaryState?.baseAsset ?? 0, 9),
					quoteAsset: round(postPrimaryState?.quoteAsset ?? 0, 6),
					baseDebt: round(postPrimaryState?.baseDebt ?? 0, 9),
					quoteDebt: round(postPrimaryState?.quoteDebt ?? 0, 6)
				}
			);

			if (secondaryStrategy === 'asset_only_withdraw') {
				await this.#ctx
					.withRetry(
						'compact withdraw after primary',
						() => service.compactCleanupWithdraw(account),
						3,
						meta
					)
					.catch((error) => recordFailure('compact withdraw after primary', error));
			} else {
				// dust_repay_withdraw, or residual debt close that primary didn't fully resolve
				await this.#ctx
					.withRetry(
						'repay and withdraw residual',
						() => service.repayAndWithdrawAll(account),
						3,
						meta
					)
					.catch((error) => recordFailure('repay and withdraw residual', error));
			}

			const postSecondaryState = await this.#ctx
				.inspectManagedAccountState(account)
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					if (!isRateLimitedErrorMessage(message)) {
						recordFailure('verify after secondary strategy', error);
					}
					return null;
				});

			if (await cacheAndReturnIfFlat(postSecondaryState)) {
				return recoverySummary;
			}

			if (postSecondaryState) {
				recordFailure(
					'cleanup failed',
					new Error(postSecondaryState.blockingReason ?? 'manager not flat')
				);
			}
		}

		errors.push(...managerErrors);
		return recoverySummary;
	}

	async forceFlatten(clearData: boolean, cleanupRunId: string | null = null): Promise<void> {
		const service = this.#ctx.getService();
		const accounts = this.#ctx.getAccounts();
		const db = this.#ctx.getDb();
		if (!service || !accounts || !db) {
			return;
		}

		const previousCleanupState = this.#ctx.getCleanupInProgress();
		this.#ctx.setCleanupInProgress(true);
		try {
			const errors: string[] = [];
			const cleanupAccount = async (account: ManagedAccount) => {
				const meta = {
					account: account.label,
					accountKey: account.key,
					phase: 'CLOSE' as const,
					cleanupRunId
				};
				const accountErrors: string[] = [];
				const recoverySummary = { count: 0, pnlUsd: 0, gasUsd: 0 };
				await this.#ctx.appendLog('info', `Forced cleanup started for ${account.label}.`, meta);

				const { managedAccounts, source, totalKnown } =
					await this.#ctx.resolveCleanupManagedAccounts(account);
				const inspectionResults = await mapWithConcurrency(
					managedAccounts,
					2,
					async (managedAccount) => {
						try {
							const managerState = await this.#ctx.inspectManagedAccountState(managedAccount);
							return { managedAccount, managerState, error: null as string | null };
						} catch (error) {
							return {
								managedAccount,
								managerState: null,
								error: error instanceof Error ? error.message : String(error)
							};
						}
					}
				);
				const cleanupTargets: ManagedAccount[] = [];

				for (const result of inspectionResults) {
					if (result.error) {
						accountErrors.push(
							`${account.label} ${result.managedAccount.marginManagerId ?? 'unknown'} inspect before cleanup: ${result.error}`
						);
						continue;
					}
					if (result.managerState && this.#ctx.managerNeedsCleanup(result.managerState)) {
						cleanupTargets.push(result.managedAccount);
					}
				}

				if (totalKnown > 1 || source === 'cache') {
					await this.#ctx.appendLog(
						'info',
						`Inspecting ${managedAccounts.length} of ${totalKnown} known margin managers for ${account.label} during cleanup.`,
						{
							...meta,
							discoverySource: source,
							totalKnown,
							inspectedManagerIds: managedAccounts.map(
								(managedAccount) => managedAccount.marginManagerId
							),
							cleanupTargets: cleanupTargets.map((managedAccount) => managedAccount.marginManagerId)
						}
					);
				}

				for (const managedAccount of cleanupTargets) {
					const managerRecovery = await this.flattenSingleManager(
						managedAccount,
						accountErrors,
						cleanupRunId
					);
					recoverySummary.count += managerRecovery.count;
					recoverySummary.pnlUsd = round(recoverySummary.pnlUsd + managerRecovery.pnlUsd, 6);
					recoverySummary.gasUsd = round(recoverySummary.gasUsd + managerRecovery.gasUsd, 6);
				}

				if (accountErrors.length > 0) {
					await this.#ctx.appendLog('error', `Forced cleanup failed for ${account.label}.`, {
						...meta,
						error: accountErrors[0],
						errorCount: accountErrors.length,
						inspectedManagers: managedAccounts.length,
						cleanupTargetCount: cleanupTargets.length
					});
				} else if (cleanupTargets.length === 0) {
					await this.#ctx.appendLog(
						'success',
						`Forced cleanup succeeded for ${account.label}; all inspected managers were already flat.`,
						{
							...meta,
							inspectedManagers: managedAccounts.length,
							cleanupTargetCount: 0,
							cleanupRecoveryCount: recoverySummary.count,
							cleanupPnlUsd: recoverySummary.count > 0 ? recoverySummary.pnlUsd : undefined,
							cleanupGasUsd: recoverySummary.count > 0 ? recoverySummary.gasUsd : undefined
						}
					);
				} else {
					await this.#ctx.appendLog('success', `Forced cleanup succeeded for ${account.label}.`, {
						...meta,
						inspectedManagers: managedAccounts.length,
						cleanupTargetCount: cleanupTargets.length,
						cleanupRecoveryCount: recoverySummary.count,
						cleanupPnlUsd: recoverySummary.count > 0 ? recoverySummary.pnlUsd : undefined,
						cleanupGasUsd: recoverySummary.count > 0 ? recoverySummary.gasUsd : undefined
					});
				}

				errors.push(...accountErrors);
			};

			await Promise.all([cleanupAccount(accounts.accountA), cleanupAccount(accounts.accountB)]);

			if (errors.length > 0) {
				throw new Error(
					`Forced cleanup failed for ${errors.length} step(s). First error: ${errors[0]}`
				);
			}

			if (clearData) {
				await db.clearAllData();
			}
		} finally {
			this.#ctx.setCleanupInProgress(previousCleanupState);
		}
	}
}
