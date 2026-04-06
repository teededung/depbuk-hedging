import { setTimeout as sleep } from 'node:timers/promises';

import { BotDatabase, type ManagerCacheRecord } from './db.js';
import { DeepBookService, type ManagedAccount } from './deepbook.js';
import {
	sanitizeSettings,
	toBotConfig,
	toConfigSummary,
	toReadOnlyBotConfig,
	validateSettingsInput
} from './config.js';
import { RuntimeCleanupExecutor } from './runtime-cleanup-executor.js';
import type {
	CleanupRecoverySummary,
	CloseState,
	OpenResidualState,
	RetryOptions,
	StartAccountState,
	StartReadinessState
} from './runtime-context.js';
import { RuntimeCycleExecutor } from './runtime-cycle-executor.js';
import {
	buildAutoBalancePreview,
	computeMaxAffordableNotional,
	buildPostCycleFundingMaintenancePlan,
	buildBalancesAndPreflightSnapshotUpdate,
	buildBlockingReason,
	buildPreflightSnapshot,
	createEmptyStartAccountState,
	createEmptyStartReadiness,
	createSnapshot,
	managerNeedsCleanup
} from './runtime-snapshot.js';
import {
	cleanupRunId,
	clientOrderId,
	defaultAccountLabel,
	extractErrorDebugMeta,
	FatalRuntimeError,
	freshestLogs,
	isFatalRuntimeErrorMessage,
	isRateLimitedErrorMessage,
	MANAGER_CACHE_DISCOVERY_TTL_MS,
	mapWithConcurrency,
	normalizeCleanupQuantity,
	normalizeQuantity,
	nowIso,
	randomInt,
	retryDelayMs,
	round,
	shortId,
	StopRequestedError,
	summarizeAggregatorDebugMeta,
	sumCycleOrderFeesUsd,
	sumCycleOrderGasUsd,
	sumFilledCycleOrderVolumeUsd
} from './runtime-shared.js';
import type {
	ActiveCycleState,
	AutoBalanceAccountPreview,
	AutoBalancePreview,
	BotAccountKey,
	BotConfig,
	BotLogEntry,
	BotSettingsView,
	CycleOrderRecord,
	NotionalMaxPreview,
	RuntimeSnapshot
} from './types.js';

type ManagedAccounts = Record<BotAccountKey, ManagedAccount>;
type StopFlowOptions = {
	startMessage: string;
	startLog?: {
		level: 'info' | 'warn' | 'error';
		message: string;
		meta: Record<string, unknown>;
	};
	finalizeMessage: string;
	successMessage: string;
	errorLogMessage: string;
	errorMessageFallback: string;
	clearCurrentCycleStateOnSuccess?: boolean;
};

const POST_CYCLE_FUNDING_TARGET_CYCLES = 2;
const POST_CYCLE_FUNDING_MIN_TRANSFER_USDC = 0.5;
const POST_CYCLE_FUNDING_MIN_SWAP_SHORTFALL_USDC = 0.5;
const POST_CYCLE_FUNDING_MIN_SWAP_SUI_IN = 0.0001;
const NOTIONAL_MAX_HEADROOM_PERCENT = 5;

export class BotRuntime {
	#snapshot: RuntimeSnapshot = createSnapshot();
	#subscribers = new Set<(snapshot: RuntimeSnapshot) => void>();
	#db: BotDatabase | null = null;
	#config: BotConfig | null = null;
	#service: DeepBookService | null = null;
	#accounts: ManagedAccounts | null = null;
	#bootPromise: Promise<void> | null = null;
	#startPromise: Promise<void> | null = null;
	#loopPromise: Promise<void> | null = null;
	#manualStop = false;
	#stopRequested = false;
	#startedAt = new Date();
	#currentCycleId: number | null = null;
	#currentCycleAuxiliaryGasUsd = 0;
	#currentCycleOrders: CycleOrderRecord[] = [];
	#pricePoller: ReturnType<typeof setInterval> | null = null;
	#pricePollInFlight = false;
	#booted = false;
	#cleanupInProgress = false;
	#activeCleanupRunId: string | null = null;
	#configSummary: RuntimeSnapshot['config'] = null;
	#settingsApplyPending = false;
	#cycleExecutor = new RuntimeCycleExecutor({
		getConfig: () => this.#config!,
		getService: () => this.#service!,
		getAccounts: () => this.#accounts!,
		getDb: () => this.#db!,
		getSnapshot: () => this.#snapshot,
		getCurrentCycleId: () => this.#currentCycleId,
		setCurrentCycleId: (id) => {
			this.#currentCycleId = id;
		},
		getCurrentCycleAuxiliaryGasUsd: () => this.#currentCycleAuxiliaryGasUsd,
		setCurrentCycleAuxiliaryGasUsd: (value) => {
			this.#currentCycleAuxiliaryGasUsd = value;
		},
		getCurrentCycleOrders: () => this.#currentCycleOrders,
		setCurrentCycleOrders: (orders) => {
			this.#currentCycleOrders = orders;
		},
		appendLog: (level, message, meta) => this.#appendLog(level, message, meta),
		persistCurrentOrders: () => this.#persistCurrentOrders(),
		setActiveCycle: (activeCycle) => this.#setActiveCycle(activeCycle),
		refreshSnapshot: () => this.#refreshSnapshot(),
		setSnapshot: (overrides) => this.#setSnapshot(overrides),
		setAutoTopupSnapshot: (overrides) => this.#setAutoTopupSnapshot(overrides),
		updateBalancesAndPreflight: (balances, referencePrice, startReadiness) =>
			this.#updateBalancesAndPreflight(balances, referencePrice, startReadiness),
		accountLabel: (account) => this.#accountLabel(account),
		throwIfStopping: () => this.#throwIfStopping(),
		sleepInterruptible: (ms) => this.#sleepInterruptible(ms),
		randomDelay: () => this.#randomDelay(),
		withRetry: (label, fn, maxAttempts, meta, options) =>
			this.#withRetry(label, fn, maxAttempts, meta, options)
	});
	#cleanupExecutor = new RuntimeCleanupExecutor({
		getService: () => this.#service!,
		getAccounts: () => this.#accounts,
		getDb: () => this.#db,
		getSnapshot: () => this.#snapshot,
		appendLog: (level, message, meta) => this.#appendLog(level, message, meta),
		withRetry: (label, fn, maxAttempts, meta, options) =>
			this.#withRetry(label, fn, maxAttempts, meta, options),
		inspectManagedAccountState: (account) => this.#inspectManagedAccountState(account),
		managerNeedsCleanup: (state) => this.#managerNeedsCleanup(state),
		resolveCleanupManagedAccounts: (account) => this.#resolveCleanupManagedAccounts(account),
		cacheManagedAccountState: (account, state, options) =>
			this.#cacheManagedAccountState(account, state, options),
		getCleanupInProgress: () => this.#cleanupInProgress,
		setCleanupInProgress: (value) => {
			this.#cleanupInProgress = value;
		},
		clientOrderId: () => this.#clientOrderId(),
		normalizeCleanupQuantity: (quantity, lotSize, minSize, options) =>
			this.#normalizeCleanupQuantity(quantity, lotSize, minSize, options)
	});

	getSnapshot(): RuntimeSnapshot {
		return JSON.parse(JSON.stringify(this.#snapshot)) as RuntimeSnapshot;
	}

	subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
		this.#subscribers.add(listener);
		listener(this.getSnapshot());
		return () => this.#subscribers.delete(listener);
	}

	async start(): Promise<void> {
		this.#manualStop = false;
		this.#stopRequested = false;

		if (this.#loopPromise || this.#startPromise) {
			return;
		}

		if (!this.#db) {
			this.#db = new BotDatabase();
			await this.#db.init();
		}

		const nextCycleNumber = await this.#db.getNextCycleNumber();
		const accountALabel = this.#accountLabel('accountA');
		const accountBLabel = this.#accountLabel('accountB');
		this.#setSnapshot({
			lifecycle: 'BOOTING',
			liveLabel: 'Offline',
			runLabel: 'BOOTING',
			message: `Start requested. Preparing cycle #${nextCycleNumber}.`
		});
		await Promise.all([
			this.#appendLog('info', `Cycle #${nextCycleNumber} was queued for ${accountALabel}.`, {
				account: accountALabel,
				accountKey: 'accountA',
				cycleNumber: nextCycleNumber,
				phase: 'OPEN',
				stage: 'queued'
			}),
			this.#appendLog('info', `Cycle #${nextCycleNumber} was queued for ${accountBLabel}.`, {
				account: accountBLabel,
				accountKey: 'accountB',
				cycleNumber: nextCycleNumber,
				phase: 'OPEN',
				stage: 'queued'
			})
		]);
		this.#startPromise = this.#completeStart(nextCycleNumber).finally(() => {
			this.#startPromise = null;
		});
	}

	async #completeStart(nextCycleNumber: number): Promise<void> {
		try {
			await this.ensureBooted(
				this.#snapshot.lifecycle === 'CONFIG_REQUIRED' || this.#settingsApplyPending
			);

			if (!this.#service || !this.#config || !this.#accounts) {
				return;
			}

			await this.refreshStartReadiness();

			if (!this.#snapshot.preflight.ready) {
				await this.#appendLog('warn', `Start request rejected for cycle #${nextCycleNumber}.`, {
					cycleNumber: nextCycleNumber,
					phase: 'OPEN',
					stage: 'queued',
					reason: this.#startBlockedMessage(this.#snapshot.preflight)
				});
				this.#setSnapshot({
					lifecycle: 'STOPPED',
					liveLabel: 'Offline',
					runLabel: 'STOPPED',
					message: this.#startBlockedMessage(this.#snapshot.preflight)
				});
				return;
			}

			if (this.#stopRequested) {
				this.#setSnapshot({
					lifecycle: 'STOPPED',
					liveLabel: 'Offline',
					runLabel: 'STOPPED',
					message: 'Start request was cancelled before the trading loop began.'
				});
				return;
			}

			this.#startedAt = new Date();
			await this.#refreshSnapshot();
			this.#setSnapshot({
				startedAt: this.#startedAt.toISOString(),
				runCycleCount: 0
			});

			this.#setSnapshot({
				lifecycle: 'RUNNING',
				liveLabel: 'Live',
				runLabel: 'RUNNING',
				message: 'DeepBook hedging bot is live.'
			});
			await this.#appendLog('info', `Start confirmed. Preparing cycle #${nextCycleNumber}.`, {
				cycleNumber: nextCycleNumber,
				phase: 'OPEN',
				stage: 'queued'
			});

			this.#loopPromise = this.#runLoop().finally(() => {
				this.#loopPromise = null;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Start failed.';
			await this.#appendLog('error', 'Start failed.', {
				error: message,
				cycleNumber: nextCycleNumber,
				phase: 'OPEN',
				stage: 'queued'
			});
			this.#setSnapshot({
				lifecycle: 'ERROR',
				liveLabel: 'Offline',
				runLabel: 'ERROR',
				message
			});
		}
	}

	async ensureBooted(force = false): Promise<void> {
		this.#ensurePricePolling();

		if (this.#booted && !force) {
			return;
		}

		if (!this.#bootPromise) {
			this.#bootPromise = this.#boot().finally(() => {
				this.#bootPromise = null;
			});
		}

		await this.#bootPromise;
	}

	async stopAndClean(): Promise<void> {
		await this.#runStopFlow({
			startMessage: 'Stopping bot and flattening positions.',
			startLog: {
				level: 'info',
				message: 'Clean started.',
				meta: {
					phase: 'CLOSE'
				}
			},
			finalizeMessage: 'Stopped by operator with cleanup.',
			successMessage: 'Bot stopped and positions were flattened. History and logs were preserved.',
			errorLogMessage: 'Clean failed.',
			errorMessageFallback: 'Clean failed.',
			clearCurrentCycleStateOnSuccess: true
		});
	}

	async stop(): Promise<void> {
		await this.#runStopFlow({
			startMessage: 'Stopping bot and flattening positions. Logs will be preserved.',
			finalizeMessage: 'Stopped by operator.',
			successMessage: 'Bot stopped. Logs and cycle history preserved.',
			errorLogMessage: 'Stop failed.',
			errorMessageFallback: 'Stop failed.'
		});
	}

	async #runStopFlow(options: StopFlowOptions): Promise<void> {
		this.#manualStop = true;
		this.#stopRequested = true;
		const currentCleanupRunId = cleanupRunId();
		this.#activeCleanupRunId = currentCleanupRunId;
		this.#setSnapshot({
			lifecycle: 'STOPPING',
			liveLabel: 'Offline',
			runLabel: 'STOPPING',
			message: options.startMessage
		});

		try {
			if (options.startLog) {
				await this.#appendLog(options.startLog.level, options.startLog.message, {
					...options.startLog.meta,
					cleanupRunId: currentCleanupRunId
				});
			}

			await this.#loopPromise;
			this.#stopRequested = false;
			await this.#finalizeCurrentCycle('stopped', options.finalizeMessage);
			await this.#forceFlatten(false, currentCleanupRunId);
			if (options.clearCurrentCycleStateOnSuccess) {
				this.#currentCycleId = null;
				this.#currentCycleOrders = [];
				await this.#refreshSnapshot();
			}
			this.#setSnapshot({
				lifecycle: 'STOPPED',
				liveLabel: 'Offline',
				runLabel: 'STOPPED',
				activeCycle: null,
				message: options.successMessage
			});
		} catch (error) {
			await this.#appendLog('error', options.errorLogMessage, {
				error: error instanceof Error ? error.message : String(error),
				cleanupRunId: currentCleanupRunId
			});
			this.#setSnapshot({
				lifecycle: 'ERROR',
				liveLabel: 'Offline',
				runLabel: 'ERROR',
				message: error instanceof Error ? error.message : options.errorMessageFallback
			});
		} finally {
			this.#activeCleanupRunId = null;
		}
	}

	async shutdown(): Promise<void> {
		this.#manualStop = true;
		this.#stopRequested = true;
		if (this.#pricePoller) {
			clearInterval(this.#pricePoller);
			this.#pricePoller = null;
		}
		await this.#loopPromise;
		await this.#db?.disconnect();
	}

	async getSettings(): Promise<BotSettingsView> {
		if (!this.#db) {
			this.#db = new BotDatabase();
			await this.#db.init();
		}
		return sanitizeSettings(await this.#db.getSettings());
	}

	async saveSettings(input: Record<string, unknown>): Promise<void> {
		if (!this.#db) {
			this.#db = new BotDatabase();
			await this.#db.init();
		}

		const existing = sanitizeSettings(await this.#db.getSettings());
		const validated = validateSettingsInput(input, existing);
		const savedRow = await this.#db.saveSettings(validated);

		if (this.#loopPromise || this.#snapshot.lifecycle === 'RUNNING') {
			this.#settingsApplyPending = true;
			this.#configSummary = this.#configSummary
				? { ...this.#configSummary, settingsApplyPending: true }
				: toConfigSummary(toReadOnlyBotConfig(savedRow), { settingsApplyPending: true });
			this.#setSnapshot({
				config: this.#configSummary,
				message: 'Settings saved. Restart bot to apply changes.'
			});
			return;
		}

		this.#settingsApplyPending = false;
		this.#service = null;
		this.#accounts = null;
		this.#config = null;
		this.#booted = false;
		await this.ensureBooted(true);
		this.#setSnapshot({
			message:
				this.#snapshot.lifecycle === 'CONFIG_REQUIRED' ? this.#snapshot.message : 'Settings saved.'
		});
	}

	async swapAccounts(): Promise<void> {
		if (!this.#db) {
			this.#db = new BotDatabase();
			await this.#db.init();
		}

		const existing = await this.#db.getSettings();
		const oldA = existing.account_a_label;
		const oldB = existing.account_b_label;

		const savedRow = await this.#db.swapAccountKeys();
		const newA = savedRow.account_a_label;
		const newB = savedRow.account_b_label;

		const state = await this.#db.loadAccountState();
		await this.#db.saveAccountState({
			accountA: state.accountB,
			accountB: state.accountA
		});

		await this.#appendLog('info', `Account swap executed: Account A is now ${newA}, Account B is now ${newB}.`, {
			event: 'account_swap',
			oldAccountA: oldA,
			oldAccountB: oldB,
			newAccountA: newA,
			newAccountB: newB
		});

		if (this.#loopPromise || this.#snapshot.lifecycle === 'RUNNING') {
			this.#settingsApplyPending = true;
			this.#configSummary = this.#configSummary
				? { ...this.#configSummary, settingsApplyPending: true }
				: toConfigSummary(toReadOnlyBotConfig(savedRow), { settingsApplyPending: true });
			
			this.#setSnapshot({
				config: this.#configSummary,
				message: 'Accounts swapped. Restart bot to apply changes.'
			});
			return;
		}

		this.#settingsApplyPending = false;
		this.#service = null;
		this.#accounts = null;
		this.#config = null;
		this.#booted = false;
		await this.ensureBooted(true);
		this.#setSnapshot({
			message:
				this.#snapshot.lifecycle === 'CONFIG_REQUIRED' ? this.#snapshot.message : 'Accounts swapped successfully.'
		});
	}

	async #boot(): Promise<void> {
		this.#startedAt = new Date();
		this.#stopRequested = false;
		this.#booted = false;
		this.#setSnapshot({
			lifecycle: 'BOOTING',
			liveLabel: 'Offline',
			runLabel: 'BOOTING',
			message: 'Loading config, database, and on-chain account state.'
		});

		if (!this.#db) {
			this.#db = new BotDatabase();
			await this.#db.init();
		}

		const settingsRow = await this.#db.getSettings();
		this.#configSummary = toConfigSummary(toReadOnlyBotConfig(settingsRow), {
			settingsApplyPending: this.#settingsApplyPending
		});
		this.#setSnapshot({
			config: this.#configSummary,
			startedAt: this.#startedAt.toISOString()
		});

		try {
			this.#config = toBotConfig(settingsRow);
			this.#service = new DeepBookService(this.#config);
			this.#accounts = this.#service.buildManagedAccounts();

			const storedState = await this.#db.loadAccountState();
			if (!this.#accounts.accountA.marginManagerId && storedState.accountA) {
				this.#accounts.accountA.marginManagerId = storedState.accountA;
			}
			if (!this.#accounts.accountB.marginManagerId && storedState.accountB) {
				this.#accounts.accountB.marginManagerId = storedState.accountB;
			}

			this.#accounts.accountA = await this.#service.ensureMarginManager(this.#accounts.accountA);
			this.#accounts.accountB = await this.#service.ensureMarginManager(this.#accounts.accountB);

			await this.#db.saveAccountState({
				accountA: this.#accounts.accountA.marginManagerId,
				accountB: this.#accounts.accountB.marginManagerId
			});
			await this.#cacheManagerDiscovery([this.#accounts.accountA, this.#accounts.accountB]);

			await this.#appendLog('info', 'Runtime initialized.', {
				accountA: this.#accounts.accountA.address,
				accountB: this.#accounts.accountB.address,
				managerA: this.#accounts.accountA.marginManagerId,
				managerB: this.#accounts.accountB.marginManagerId,
				pool: this.#config.pool_key
			});

			this.#settingsApplyPending = false;
			this.#configSummary = toConfigSummary(this.#config, {
				settingsApplyPending: false
			});
			await this.#refreshSnapshot();
			this.#setSnapshot({
				lifecycle: 'STOPPED',
				liveLabel: 'Offline',
				runLabel: 'STOPPED',
				config: this.#configSummary,
				message: 'Bot ready. Press Start to begin trading.'
			});
			this.#booted = true;
		} catch (error) {
			console.error('BOOT ERROR', error);
			this.#settingsApplyPending = false;
			this.#config = toReadOnlyBotConfig(settingsRow);
			this.#configSummary = toConfigSummary(this.#config, {
				settingsApplyPending: false
			});
			this.#service = null;
			this.#accounts = null;
			this.#setSnapshot({
				lifecycle: 'CONFIG_REQUIRED',
				liveLabel: 'Offline',
				runLabel: 'STOPPED',
				config: this.#configSummary,
				message:
					error instanceof Error
						? `Settings are present but not ready: ${error.message}`
						: 'Settings are present but not ready.'
			});
			await this.#refreshReadOnlyPrice().catch(() => {});
			this.#booted = true;
		}
	}

	async #runLoop(): Promise<void> {
		if (!this.#config || !this.#service || !this.#accounts) {
			return;
		}

		while (!this.#stopRequested) {
			if (await this.#hasReachedCycleLimit()) {
				this.#setSnapshot({
					lifecycle: 'STOPPED',
					liveLabel: 'Offline',
					runLabel: 'STOPPED',
					message: `Reached configured max_cycles (${this.#config.max_cycles}).`
				});
				this.#manualStop = true;
				break;
			}

			try {
				await this.#executeCycle();

				if (this.#stopRequested || this.#cleanupInProgress) {
					continue;
				}

				if (await this.#hasReachedCycleLimit()) {
					continue;
				}

				await this.#maintainFundingBetweenCycles();
			} catch (error) {
				if (error instanceof StopRequestedError) {
					break;
				}
				const cycleNumber = this.#snapshot.activeCycle?.cycleNumber ?? null;
				const shouldAutoCleanAfterFailure = this.#currentCycleOrders.some(
					(order) =>
						Boolean(order.txDigest) ||
						Boolean(order.orderId) ||
						order.status === 'filled' ||
						order.status === 'open'
				);
				const postFailureCleanupRunId = shouldAutoCleanAfterFailure ? cleanupRunId() : null;

				await this.#finalizeCurrentCycle(
					'failed',
					error instanceof Error ? error.message : 'Cycle failed.'
				);

				if (error instanceof FatalRuntimeError) {
					await this.#appendLog('error', 'Cycle failed. Bot stopped without retry.', {
						error: error.message
					});
					await this.#forceFlatten(false);
					this.#manualStop = true;
					this.#stopRequested = true;
					this.#setSnapshot({
						lifecycle: 'STOPPED',
						liveLabel: 'Offline',
						runLabel: 'STOPPED',
						message: `Bot stopped after fatal error: ${error.message}`
					});
					break;
				}

				await this.#appendLog('error', 'Cycle failed.', {
					error: error instanceof Error ? error.message : String(error)
				});

				if (shouldAutoCleanAfterFailure) {
					await this.#appendLog(
						'warn',
						cycleNumber
							? `Cycle #${cycleNumber} left on-chain state; attempting cleanup before continuing.`
							: 'Cycle left on-chain state; attempting cleanup before continuing.',
						{
							cycleNumber,
							cleanupRunId: postFailureCleanupRunId
						}
					);

					try {
						await this.#forceFlatten(false, postFailureCleanupRunId);
					} catch (cleanupError) {
						const cleanupMessage =
							cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
						await this.#appendLog(
							'error',
							'Post-failure cleanup failed. Bot stopped without retry.',
							{
								cycleNumber,
								cleanupRunId: postFailureCleanupRunId,
								error: cleanupMessage
							}
						);
						this.#manualStop = true;
						this.#stopRequested = true;
						this.#setSnapshot({
							lifecycle: 'STOPPED',
							liveLabel: 'Offline',
							runLabel: 'STOPPED',
							message: `Bot stopped after failed-cycle cleanup error: ${cleanupMessage}`
						});
						break;
					}
				}

				this.#setSnapshot({
					lifecycle: 'ERROR',
					liveLabel: 'Offline',
					runLabel: 'ERROR',
					message: error instanceof Error ? error.message : 'Cycle failed.'
				});

				if (this.#stopRequested) {
					break;
				}

				if (await this.#hasReachedCycleLimit()) {
					this.#setSnapshot({
						lifecycle: 'STOPPED',
						liveLabel: 'Offline',
						runLabel: 'STOPPED',
						message: `Reached configured max_cycles (${this.#config.max_cycles}).`
					});
					this.#manualStop = true;
					break;
				}

				await sleep(5000);
				this.#setSnapshot({
					lifecycle: 'RUNNING',
					liveLabel: 'Live',
					runLabel: 'RUNNING',
					message: 'Recovered from cycle error and retrying.'
				});
			}
		}
	}

	#buildPreflightSnapshot(
		balances: RuntimeSnapshot['balances'],
		referencePrice: number,
		startReadiness: StartReadinessState = createEmptyStartReadiness()
	): RuntimeSnapshot['preflight'] {
		return buildPreflightSnapshot({
			config: this.#config,
			balances,
			referencePrice,
			startReadiness
		});
	}

	#buildBlockingReason(state: StartAccountState): string | undefined {
		return buildBlockingReason(state);
	}

	#managerNeedsCleanup(state: StartAccountState): boolean {
		return managerNeedsCleanup(state);
	}

	async #cacheManagerDiscovery(managedAccounts: ManagedAccount[]): Promise<void> {
		if (!this.#db || !this.#service) {
			return;
		}

		const poolId = this.#service.pool.address;
		const entries = managedAccounts
			.filter((managedAccount) => Boolean(managedAccount.marginManagerId))
			.map((managedAccount) => ({
				managerId: managedAccount.marginManagerId!,
				accountKey: managedAccount.key,
				ownerAddress: managedAccount.address,
				poolId,
				balanceManagerId: managedAccount.balanceManagerId,
				status: 'unknown' as const
			}));

		if (entries.length > 0) {
			await this.#db.upsertManagerCache(entries);
		}
	}

	async #cacheManagedAccountState(
		managedAccount: ManagedAccount,
		state: StartAccountState,
		options: {
			lastCleanupAt?: string;
			lastCleanupError?: string | null;
		} = {}
	): Promise<void> {
		if (!this.#db || !this.#service || !managedAccount.marginManagerId) {
			return;
		}

		await this.#db.upsertManagerCache([
			{
				managerId: managedAccount.marginManagerId,
				accountKey: managedAccount.key,
				ownerAddress: managedAccount.address,
				poolId: this.#service.pool.address,
				balanceManagerId: managedAccount.balanceManagerId,
				status: state.isBlocked ? 'dirty' : 'flat',
				openOrdersCount: state.openOrdersCount,
				baseAsset: state.baseAsset,
				quoteAsset: state.quoteAsset,
				baseDebt: state.baseDebt,
				quoteDebt: state.quoteDebt,
				lastVerifiedAt: nowIso(),
				lastCleanupAt: options.lastCleanupAt,
				lastCleanupError: options.lastCleanupError ?? null
			}
		]);
	}

	#isFreshManagerCache(entry: ManagerCacheRecord): boolean {
		return Date.now() - new Date(entry.updatedAt).getTime() <= MANAGER_CACHE_DISCOVERY_TTL_MS;
	}

	async #inspectManagedAccountState(managedAccount: ManagedAccount): Promise<StartAccountState> {
		if (!this.#service) {
			return createEmptyStartAccountState();
		}

		const loadManagerState = async () => {
			for (let attempt = 1; attempt <= 5; attempt += 1) {
				try {
					return await this.#service!.getMarginManagerState(managedAccount);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!isRateLimitedErrorMessage(message) || attempt === 5) {
						throw error;
					}
					await sleep(retryDelayMs(message, attempt));
				}
			}

			throw new Error(`Unable to inspect margin manager for ${managedAccount.label}`);
		};

		const managerState = await loadManagerState();
		const loadOpenOrders = async () => {
			for (let attempt = 1; attempt <= 5; attempt += 1) {
				try {
					return await this.#service!.getAccountOpenOrders(managedAccount);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!isRateLimitedErrorMessage(message) || attempt === 5) {
						throw error;
					}
					await sleep(retryDelayMs(message, attempt));
				}
			}

			throw new Error(`Unable to inspect open orders for ${managedAccount.label}`);
		};

		const openOrders = await loadOpenOrders();
		const state: StartAccountState = {
			managerId: managerState.managerId,
			openOrdersCount: openOrders.length,
			baseAsset: round(managerState.baseAsset, 9),
			quoteAsset: round(managerState.quoteAsset, 6),
			baseDebt: round(managerState.baseDebt, 9),
			quoteDebt: round(managerState.quoteDebt, 6),
			isBlocked: false
		};

		state.blockingReason = this.#buildBlockingReason(state);
		state.isBlocked = Boolean(state.blockingReason);
		await this.#cacheManagedAccountState(managedAccount, state);
		return state;
	}

	async #loadStartReadiness(): Promise<StartReadinessState> {
		if (!this.#service || !this.#accounts) {
			return createEmptyStartReadiness();
		}

		const inspectAccount = async (account: ManagedAccount): Promise<StartAccountState> => {
			try {
				const managedAccounts = await this.#resolvePoolManagedAccounts(account);
				const aggregate: StartAccountState = {
					...createEmptyStartAccountState(),
					managerId: account.marginManagerId ?? managedAccounts[0]?.marginManagerId
				};
				const blockers: string[] = [];
				const managerReadinessList = await mapWithConcurrency(
					managedAccounts,
					2,
					(managedAccount) => this.#inspectManagedAccountState(managedAccount)
				);

				for (const managerReadiness of managerReadinessList) {
					aggregate.openOrdersCount += managerReadiness.openOrdersCount;
					aggregate.baseAsset = round(aggregate.baseAsset + managerReadiness.baseAsset, 9);
					aggregate.quoteAsset = round(aggregate.quoteAsset + managerReadiness.quoteAsset, 6);
					aggregate.baseDebt = round(aggregate.baseDebt + managerReadiness.baseDebt, 9);
					aggregate.quoteDebt = round(aggregate.quoteDebt + managerReadiness.quoteDebt, 6);

					if (managerReadiness.blockingReason) {
						blockers.push(
							`${shortId(managerReadiness.managerId)}: ${managerReadiness.blockingReason}`
						);
					}
				}

				aggregate.blockingReason = blockers.length > 0 ? blockers.join(' | ') : undefined;
				aggregate.isBlocked = blockers.length > 0;
				return aggregate;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes('429')) {
					return {
						...createEmptyStartAccountState(),
						managerId: account.marginManagerId,
						isBlocked: false
					};
				}
				return {
					...createEmptyStartAccountState(),
					managerId: account.marginManagerId,
					isBlocked: true,
					blockingReason:
						error instanceof Error
							? `Unable to inspect on-chain account state: ${error.message}`
							: 'Unable to inspect on-chain account state.'
				};
			}
		};

		const [accountA, accountB] = await Promise.all([
			inspectAccount(this.#accounts.accountA),
			inspectAccount(this.#accounts.accountB)
		]);

		return { accountA, accountB };
	}

	#startBlockedMessage(preflight: RuntimeSnapshot['preflight']): string {
		if (preflight.state === 'needs-reset') {
			return 'Start blocked: flatten existing open orders, margin balances, or debt before running a new cycle.';
		}
		if (preflight.state === 'needs-funding') {
			return 'Start blocked: top up wallet balances before running the next cycle.';
		}
		if (preflight.state === 'waiting-price') {
			return 'Start blocked: waiting for a live SUI price quote.';
		}
		return 'Start blocked: review account readiness before running the bot.';
	}

	async #resolvePoolManagedAccounts(account: ManagedAccount): Promise<ManagedAccount[]> {
		if (!this.#service) {
			return [account];
		}

		const poolManagers = await this.#service.listOwnedPoolMarginManagers(account).catch(() => []);
		if (poolManagers.length === 0) {
			return [account];
		}

		const managedAccounts = poolManagers.map((manager) => ({
			...account,
			marginManagerId: manager.managerId,
			balanceManagerId: undefined
		}));

		await this.#cacheManagerDiscovery(managedAccounts);
		return managedAccounts;
	}

	async #resolveCleanupManagedAccounts(account: ManagedAccount): Promise<{
		managedAccounts: ManagedAccount[];
		source: 'cache' | 'chain';
		totalKnown: number;
	}> {
		if (!this.#db) {
			const managedAccounts = await this.#resolvePoolManagedAccounts(account);
			return {
				managedAccounts,
				source: 'chain',
				totalKnown: managedAccounts.length
			};
		}

		const cachedManagers = await this.#db
			.listManagerCache(account.key, account.address)
			.catch(() => []);
		const freshManagers = cachedManagers.filter((entry) => this.#isFreshManagerCache(entry));
		if (freshManagers.length > 0) {
			const entriesById = new Map(
				freshManagers.map(
					(entry) => [entry.managerId, entry] satisfies [string, ManagerCacheRecord]
				)
			);
			const candidateIds = new Set<string>();
			if (account.marginManagerId) {
				candidateIds.add(account.marginManagerId);
			}
			for (const entry of freshManagers) {
				if (entry.status !== 'flat') {
					candidateIds.add(entry.managerId);
				}
			}

			return {
				managedAccounts: [...candidateIds].map((managerId) => ({
					...account,
					marginManagerId: managerId,
					balanceManagerId: entriesById.get(managerId)?.balanceManagerId
				})),
				source: 'cache',
				totalKnown: freshManagers.length
			};
		}

		const managedAccounts = await this.#resolvePoolManagedAccounts(account);
		return {
			managedAccounts,
			source: 'chain',
			totalKnown: managedAccounts.length
		};
	}

	#updateBalancesAndPreflight(
		balances: RuntimeSnapshot['balances'],
		referencePrice: number,
		startReadiness?: StartReadinessState
	): void {
		this.#setSnapshot(
			buildBalancesAndPreflightSnapshotUpdate({
				snapshot: this.#snapshot,
				config: this.#config,
				balances,
				referencePrice,
				startReadiness
			})
		);
	}

	#setAutoTopupSnapshot(overrides: Partial<RuntimeSnapshot['autoTopup']>): void {
		this.#setSnapshot({
			autoTopup: {
				...this.#snapshot.autoTopup,
				...overrides,
				updatedAt: nowIso()
			}
		});
	}

	async #executeCycle(): Promise<void> {
		this.#ensureReady();
		return this.#cycleExecutor.executeCycle();
	}

	async #planWalletFundingForCycle(
		input: Parameters<RuntimeCycleExecutor['planWalletFundingForCycle']>[0]
	) {
		return this.#cycleExecutor.planWalletFundingForCycle(input);
	}

	async #settleFilledBalances(
		entries: Parameters<RuntimeCycleExecutor['settleFilledBalances']>[0],
		cycleNumber: number,
		phase: 'OPEN' | 'CLOSE'
	): Promise<void> {
		return this.#cycleExecutor.settleFilledBalances(entries, cycleNumber, phase);
	}

	async #loadCloseState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT'
	): Promise<CloseState> {
		return this.#cycleExecutor.loadCloseState(account, cycleNumber, side);
	}

	async #reloadCloseResidualState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT'
	): Promise<CloseState> {
		return this.#cycleExecutor.reloadCloseResidualState(account, cycleNumber, side);
	}

	async #reloadOpenResidualState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT',
		targetQuantity: number,
		orderPrice: number
	): Promise<OpenResidualState> {
		return this.#cycleExecutor.reloadOpenResidualState(
			account,
			cycleNumber,
			side,
			targetQuantity,
			orderPrice
		);
	}

	#normalizeCloseQuantityOrThrow(
		quantity: number,
		lotSize: number,
		minSize: number,
		message: string
	): number {
		return this.#cycleExecutor.normalizeCloseQuantityOrThrow(quantity, lotSize, minSize, message);
	}

	async #submitMakerOrder(input: Parameters<RuntimeCycleExecutor['submitMakerOrder']>[0]) {
		return this.#cycleExecutor.submitMakerOrder(input);
	}

	async #reconcileSubmittedOrderId(
		account: ManagedAccount,
		clientOrderIdValue: string,
		txDigest: string,
		knownOpenOrderIds: string[],
		meta: {
			side: 'LONG' | 'SHORT';
			phase: 'OPEN' | 'CLOSE';
			cycleNumber?: number | null;
		}
	): Promise<string | undefined> {
		return this.#cycleExecutor.reconcileSubmittedOrderId(
			account,
			clientOrderIdValue,
			txDigest,
			knownOpenOrderIds,
			meta
		);
	}

	async #waitForFullFill(orderIndex: number, targetQuantity: number) {
		return this.#cycleExecutor.waitForFullFill(orderIndex, targetQuantity);
	}

	async #cleanupAccounts(): Promise<void> {
		this.#ensureReady();
		return this.#cleanupExecutor.cleanupAccounts();
	}

	async #lookupCleanupEntryBasis(account: ManagedAccount, side: 'LONG' | 'SHORT') {
		return this.#cleanupExecutor.lookupCleanupEntryBasis(account, side);
	}

	async #recordCleanupRecovery(
		input: Parameters<RuntimeCleanupExecutor['recordCleanupRecovery']>[0]
	): Promise<CleanupRecoverySummary | null> {
		return this.#cleanupExecutor.recordCleanupRecovery(input);
	}

	async #flattenSingleManager(
		account: ManagedAccount,
		errors: string[],
		cleanupRunId: string | null = null
	): Promise<CleanupRecoverySummary> {
		return this.#cleanupExecutor.flattenSingleManager(account, errors, cleanupRunId);
	}

	async #forceFlatten(clearData: boolean, cleanupRunId: string | null = null): Promise<void> {
		return this.#cleanupExecutor.forceFlatten(clearData, cleanupRunId);
	}

	async #finalizeCurrentCycle(status: 'failed' | 'stopped', note: string): Promise<void> {
		if (!this.#db || !this.#currentCycleId) {
			this.#currentCycleOrders = [];
			this.#currentCycleAuxiliaryGasUsd = 0;
			this.#currentCycleId = null;
			this.#setSnapshot({ activeCycle: null });
			return;
		}

		const holdStartedAt = this.#snapshot.activeCycle?.holdStartedAt
			? new Date(this.#snapshot.activeCycle.holdStartedAt)
			: null;
		const holdSecondsActual = holdStartedAt
			? Math.round((Date.now() - holdStartedAt.getTime()) / 1000)
			: 0;
		const closePrice = this.#snapshot.activeCycle?.price ?? this.#snapshot.price.price ?? 0;
		const orderStatus = status === 'stopped' ? 'cancelled' : 'failed';
		const cycleNumber = this.#snapshot.activeCycle?.cycleNumber;

		for (const order of this.#currentCycleOrders) {
			if (order.status === 'pending' || order.status === 'open') {
				const previousStatus = order.status;
				order.status = orderStatus;
				await this.#appendLog(
					status === 'stopped' ? 'info' : 'warn',
					`${order.side} ${order.phase.toLowerCase()} order marked ${orderStatus} after cycle ${status}.`,
					{
						account: this.#accountLabel(order.account),
						accountKey: order.account,
						side: order.side,
						phase: order.phase,
						cycleNumber,
						orderId: order.orderId,
						txDigest: order.txDigest,
						previousStatus,
						note
					}
				);
			}
		}

		await this.#db.updateCycleOrders(this.#currentCycleId, this.#currentCycleOrders);
		await this.#db.finishCycle(this.#currentCycleId, {
			status,
			volumeUsd: sumFilledCycleOrderVolumeUsd(this.#currentCycleOrders),
			feesUsd: sumCycleOrderFeesUsd(this.#currentCycleOrders),
			gasUsd: round(
				sumCycleOrderGasUsd(this.#currentCycleOrders) + this.#currentCycleAuxiliaryGasUsd,
				6
			),
			pnlUsd: 0,
			holdSecondsActual,
			closePrice,
			orders: this.#currentCycleOrders,
			note
		});

		this.#currentCycleId = null;
		this.#currentCycleAuxiliaryGasUsd = 0;
		this.#currentCycleOrders = [];
		this.#setSnapshot({ activeCycle: null });
		await this.#refreshSnapshot();
	}

	async #hasReachedCycleLimit(): Promise<boolean> {
		if (!this.#config?.max_cycles || !this.#db) {
			return false;
		}

		return (await this.#db.countCyclesSince(this.#startedAt)) >= this.#config.max_cycles;
	}

	async refreshStartReadiness(): Promise<void> {
		await this.ensureBooted(this.#snapshot.lifecycle === 'CONFIG_REQUIRED');

		if (!this.#service || !this.#accounts || !this.#config) {
			return;
		}

		const livePrice = await this.#service.getLivePriceQuote(this.#accounts).catch(() => ({
			price: this.#snapshot.price.price,
			source: this.#snapshot.price.source
		}));
		const balances = await this.#service
			.getWalletBalances(this.#accounts, livePrice.price)
			.catch(() => this.#snapshot.balances);
		const startReadiness = await this.#loadStartReadiness();
		const preflight = this.#buildPreflightSnapshot(balances, livePrice.price, startReadiness);

		this.#setSnapshot({
			price: {
				source: livePrice.source,
				price: round(livePrice.price, 6),
				updatedAt: nowIso(),
				uptimeSeconds: Math.round((Date.now() - this.#startedAt.getTime()) / 1000)
			},
			balances,
			preflight,
			updatedAt: nowIso()
		});
	}

	async previewNotionalMax(): Promise<NotionalMaxPreview> {
		await this.ensureBooted(this.#snapshot.lifecycle === 'CONFIG_REQUIRED');
		if (!this.#service || !this.#accounts || !this.#config) {
			throw new Error('Runtime is not initialized.');
		}

		const livePrice = await this.#service.getLivePriceQuote(this.#accounts).catch(() => ({
			price: this.#snapshot.price.price,
			source: this.#snapshot.price.source
		}));
		const referencePrice = livePrice.price;
		if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
			throw new Error('Waiting for a live SUI price quote.');
		}

		const balances = await this.#service.getWalletBalances(this.#accounts, referencePrice);
		this.#updateBalancesAndPreflight(balances, referencePrice);

		const ceiling = computeMaxAffordableNotional({
			config: this.#config,
			balances,
			referencePrice
		});
		const safeMax = Math.floor(Math.max(ceiling.maxAffordableNotionalUsd, 0) * 10) / 10;
		if (safeMax < 0.1) {
			throw new Error('Current wallet balances are too low to derive a safe max notional.');
		}

		const recommendedRaw = safeMax * (1 - NOTIONAL_MAX_HEADROOM_PERCENT / 100);
		const recommendedNotionalUsd = Math.floor(Math.max(recommendedRaw, 0.1) * 10) / 10;

		return {
			referencePrice: round(referencePrice, 6),
			accountACeilingUsd: ceiling.accountACeilingUsd,
			accountBCeilingUsd: ceiling.accountBCeilingUsd,
			maxAffordableNotionalUsd: safeMax,
			recommendedNotionalUsd,
			headroomPercent: NOTIONAL_MAX_HEADROOM_PERCENT,
			limitingAccount: ceiling.limitingAccount,
			updatedAt: nowIso()
		};
	}

	async previewAutoBalance(targetCycles: number): Promise<AutoBalancePreview> {
		await this.ensureBooted(this.#snapshot.lifecycle === 'CONFIG_REQUIRED');
		const blockedPreviewAccount = (
			account: BotAccountKey,
			reason: string
		): AutoBalanceAccountPreview => ({
			account,
			label: this.#accountLabel(account),
			targetAsset: account === 'accountA' ? 'SUI' : 'USDC',
			sourceAsset: account === 'accountA' ? 'USDC' : 'SUI',
			workingCapitalAmount: 0,
			reserveAmount: 0,
			reservePerExtraCycleUsd: 0,
			targetAmount: 0,
			currentAmount: 0,
			shortfallAmount: 0,
			estimatedSourceAmount: 0,
			availableSourceAmount: 0,
			state: 'blocked',
			reason
		});

		if (!this.#service || !this.#accounts || !this.#config) {
			await this.ensureBooted(true);
		}

		if (!this.#service || !this.#accounts || !this.#config) {
			return {
				targetCycles,
				referencePrice: 0,
				accountA: blockedPreviewAccount('accountA', 'Runtime not initialized.'),
				accountB: blockedPreviewAccount('accountB', 'Runtime not initialized.'),
				canExecute: false,
				message: 'Runtime is not initialized.'
			};
		}

		const blockReason = this.#autoBalanceBlockReason();
		if (blockReason) {
			return {
				targetCycles,
				referencePrice: this.#snapshot.price.price,
				accountA: blockedPreviewAccount('accountA', blockReason),
				accountB: blockedPreviewAccount('accountB', blockReason),
				canExecute: false,
				message: blockReason
			};
		}

		const config = this.#config;
		const livePrice = await this.#service.getLivePriceQuote(this.#accounts).catch(() => ({
			price: this.#snapshot.price.price,
			source: this.#snapshot.price.source
		}));
		const referencePrice = livePrice.price;
		if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
			return {
				targetCycles,
				referencePrice: 0,
				accountA: blockedPreviewAccount('accountA', 'No live price available.'),
				accountB: blockedPreviewAccount('accountB', 'No live price available.'),
				canExecute: false,
				message: 'Waiting for a live SUI price quote.'
			};
		}

		const balances = await this.#service.getWalletBalances(this.#accounts, referencePrice);
		this.#updateBalancesAndPreflight(balances, referencePrice);

		const startReadiness = await this.#loadStartReadiness();
		const recentCycles =
			this.#snapshot.history.length > 0
				? this.#snapshot.history
				: this.#db
					? await this.#db.listRecentCycles(24)
					: [];

		return buildAutoBalancePreview({
			config,
			balances,
			referencePrice,
			targetCycles,
			startReadiness,
			accountALabel: this.#accountLabel('accountA'),
			accountBLabel: this.#accountLabel('accountB'),
			recentCycles
		});
	}

	async runAutoBalance(targetCycles: number): Promise<RuntimeSnapshot> {
		let preview = await this.previewAutoBalance(targetCycles);
		if (!preview.canExecute) {
			throw new Error(preview.message || 'Auto-balance cannot execute right now.');
		}

		await this.#appendLog('info', `Auto-balance started for ${targetCycles} target cycle(s).`, {
			targetCycles,
			referencePrice: preview.referencePrice
		});

		const service = this.#service!;
		const accounts = this.#accounts!;

		if (preview.shareTransfer && preview.shareTransfer.amount > 0) {
			const from = accounts[preview.shareTransfer.from];
			const to = accounts[preview.shareTransfer.to];
			const transferAsset = preview.shareTransfer.asset;
			const transferAmount = preview.shareTransfer.amount;
			await this.#appendLog(
				'info',
				`Funding prep: sharing ~${transferAmount.toFixed(4)} ${transferAsset} from ${from.label} to ${to.label} before swaps.`,
				{
					fromAccount: from.label,
					fromAccountKey: from.key,
					toAccount: to.label,
					toAccountKey: to.key,
					asset: transferAsset,
					amount: transferAmount
				}
			);

			try {
				const transfer = await this.#withRetry(
					`auto-balance transfer ${from.label} -> ${to.label}`,
					() =>
						transferAsset === 'USDC'
							? service.transferUsdcBetweenAccounts({
									from,
									to,
									amount: transferAmount
								})
							: service.transferSuiBetweenAccounts({
									from,
									to,
									amount: transferAmount
								}),
					3,
					{
						fromAccount: from.label,
						fromAccountKey: from.key,
						toAccount: to.label,
						toAccountKey: to.key,
						asset: transferAsset,
						amount: transferAmount
					}
				);

				await this.#appendLog(
					'success',
					`Funding prep: shared ${transfer.amount.toFixed(4)} ${transferAsset} from ${from.label} to ${to.label}.`,
					{
						fromAccount: from.label,
						fromAccountKey: from.key,
						toAccount: to.label,
						toAccountKey: to.key,
						asset: transferAsset,
						amount: transfer.amount,
						txDigest: transfer.txDigest,
						coinType: transfer.coinType
					}
				);

				const balances = await service
					.getWalletBalances(accounts, preview.referencePrice)
					.catch(() => this.#snapshot.balances);
				this.#updateBalancesAndPreflight(balances, preview.referencePrice);
				preview = await this.previewAutoBalance(targetCycles);
				if (!preview.canExecute) {
					throw new Error(preview.message || 'Funding prep transfer did not satisfy requirements.');
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const errorContext = extractErrorDebugMeta(error);
				await this.#appendLog('error', 'Auto-balance: balance sharing transfer failed.', {
					error: message,
					errorContext,
					fromAccount: from.label,
					toAccount: to.label
				});
				throw error;
			}
		}

		for (const acctPreview of [preview.accountA, preview.accountB] as AutoBalanceAccountPreview[]) {
			if (acctPreview.state !== 'planned') continue;

			const account = accounts[acctPreview.account];
			await this.#appendLog(
				'info',
				`Funding prep: swapping ~${acctPreview.estimatedSourceAmount.toFixed(4)} ${acctPreview.sourceAsset} → ${acctPreview.targetAsset} for ${account.label}.`,
				{
					account: account.label,
					accountKey: acctPreview.account,
					targetAsset: acctPreview.targetAsset,
					sourceAsset: acctPreview.sourceAsset,
					shortfallAmount: acctPreview.shortfallAmount,
					estimatedSourceAmount: acctPreview.estimatedSourceAmount
				}
			);

			try {
				const result = await this.#withRetry(
					`auto-balance swap for ${account.label}`,
					() =>
						service.swapExactInWithAggregator({
							account,
							coinTypeIn:
								acctPreview.sourceAsset === 'SUI'
									? service.coins.SUI.type
									: service.coins.USDC.type,
							coinTypeOut:
								acctPreview.targetAsset === 'SUI'
									? service.coins.SUI.type
									: service.coins.USDC.type,
							amountIn: acctPreview.estimatedSourceAmount,
							useGasCoin: acctPreview.sourceAsset === 'SUI'
						}),
					3,
					{ account: account.label, accountKey: acctPreview.account }
				);

				await this.#appendLog(
					'success',
					`Funding prep: swap completed for ${account.label}. Got ${result.amountOut.toFixed(4)} ${acctPreview.targetAsset}.`,
					{
						account: account.label,
						accountKey: acctPreview.account,
						targetAsset: acctPreview.targetAsset,
						sourceAsset: acctPreview.sourceAsset,
						amountIn: result.amountIn,
						amountOut: result.amountOut,
						txDigest: result.txDigest,
						provider: result.provider
					}
				);

				const balances = await service
					.getWalletBalances(accounts, preview.referencePrice)
					.catch(() => this.#snapshot.balances);
				this.#updateBalancesAndPreflight(balances, preview.referencePrice);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const errorContext = extractErrorDebugMeta(error);
					const aggregatorContext = summarizeAggregatorDebugMeta(errorContext);
					await this.#appendLog('error', `Auto-balance: swap failed for ${account.label}.`, {
						account: account.label,
						accountKey: acctPreview.account,
						error: message,
						errorContext,
						aggregatorContext
					});
					throw error;
				}
			}

		await this.#appendLog('info', 'Auto-balance completed.', { targetCycles });
		await this.#refreshSnapshot();
		return this.#snapshot;
	}

	async #buildPostCycleFundingPreview(input: {
		referencePrice: number;
		balances: RuntimeSnapshot['balances'];
	}): Promise<AutoBalancePreview> {
		const startReadiness = await this.#loadStartReadiness();
		const recentCycles =
			this.#snapshot.history.length > 0
				? this.#snapshot.history
				: this.#db
					? await this.#db.listRecentCycles(24)
					: [];

		return buildAutoBalancePreview({
			config: this.#config!,
			balances: input.balances,
			referencePrice: input.referencePrice,
			targetCycles: POST_CYCLE_FUNDING_TARGET_CYCLES,
			startReadiness,
			accountALabel: this.#accountLabel('accountA'),
			accountBLabel: this.#accountLabel('accountB'),
			recentCycles
		});
	}

	async #refreshPostCycleFundingBalances(referencePrice: number): Promise<RuntimeSnapshot['balances']> {
		if (!this.#service || !this.#accounts) {
			return this.#snapshot.balances;
		}

		const balances = await this.#service
			.getWalletBalances(this.#accounts, referencePrice)
			.catch(() => this.#snapshot.balances);
		this.#updateBalancesAndPreflight(balances, referencePrice);
		return balances;
	}

	async #maintainFundingBetweenCycles(): Promise<void> {
		if (
			!this.#config ||
			!this.#service ||
			!this.#accounts ||
			!this.#config.auto_swap_enabled ||
			this.#cleanupInProgress ||
			this.#stopRequested
		) {
			return;
		}

		try {
			const service = this.#service;
			const accounts = this.#accounts;
			const livePrice = await service.getLivePriceQuote(accounts).catch(() => ({
				price: this.#snapshot.price.price,
				source: this.#snapshot.price.source
			}));
			const referencePrice = livePrice.price;
			if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
				return;
			}

			let balances = await this.#refreshPostCycleFundingBalances(referencePrice);
			let preview = await this.#buildPostCycleFundingPreview({ referencePrice, balances });
			let plan = buildPostCycleFundingMaintenancePlan({
				config: this.#config,
				balances,
				preview,
				minTransferUsdc: POST_CYCLE_FUNDING_MIN_TRANSFER_USDC,
				minSwapShortfallUsdc: POST_CYCLE_FUNDING_MIN_SWAP_SHORTFALL_USDC,
				minSwapSuiIn: POST_CYCLE_FUNDING_MIN_SWAP_SUI_IN
			});

			if (plan.blockedAccounts.length > 0) {
				await this.#appendLog(
					'warn',
					'Post-cycle funding maintenance skipped: account state requires cleanup.',
					{
						blockedAccounts: plan.blockedAccounts,
						targetCycles: POST_CYCLE_FUNDING_TARGET_CYCLES
					}
				);
				return;
			}

			if (plan.swaps.length === 0) {
				await this.#appendLog('info', 'Post-cycle funding already balanced.', {
					targetCycles: POST_CYCLE_FUNDING_TARGET_CYCLES,
					referencePrice: round(referencePrice, 6)
				});
				return;
			}

			await this.#appendLog('info', 'Post-cycle funding maintenance started.', {
				targetCycles: POST_CYCLE_FUNDING_TARGET_CYCLES,
				referencePrice: round(referencePrice, 6)
			});

			for (const swapPlan of plan.swaps) {
				const account = accounts[swapPlan.account];
				if (swapPlan.availableSourceAmount + 1e-9 < swapPlan.estimatedSourceAmount) {
					await this.#appendLog(
						'warn',
						`Funding maintenance skipped swap for ${account.label}: not enough ${swapPlan.sourceAsset} available.`,
						{
							account: account.label,
							accountKey: account.key,
							targetAsset: swapPlan.targetAsset,
							sourceAsset: swapPlan.sourceAsset,
							shortfallAmount: swapPlan.shortfallAmount,
							estimatedSourceAmount: swapPlan.estimatedSourceAmount,
							availableSourceAmount: swapPlan.availableSourceAmount
						}
					);
					continue;
				}

				await this.#appendLog('info', `Funding maintenance swap planned for ${account.label}.`, {
					account: account.label,
					accountKey: account.key,
					targetAsset: swapPlan.targetAsset,
					sourceAsset: swapPlan.sourceAsset,
					shortfallAmount: swapPlan.shortfallAmount,
					estimatedSourceAmount: swapPlan.estimatedSourceAmount
				});

				try {
					const result = await this.#withRetry(
						`funding maintenance swap for ${account.label}`,
						() =>
							service.swapExactInWithAggregator({
								account,
								coinTypeIn:
									swapPlan.sourceAsset === 'SUI'
										? service.coins.SUI.type
										: service.coins.USDC.type,
								coinTypeOut:
									swapPlan.targetAsset === 'SUI'
										? service.coins.SUI.type
										: service.coins.USDC.type,
								amountIn: swapPlan.estimatedSourceAmount,
								useGasCoin: swapPlan.sourceAsset === 'SUI'
							}),
						3,
						{
							account: account.label,
							accountKey: account.key,
							targetAsset: swapPlan.targetAsset,
							sourceAsset: swapPlan.sourceAsset,
							shortfallAmount: swapPlan.shortfallAmount,
							estimatedSourceAmount: swapPlan.estimatedSourceAmount
						}
					);

					await this.#appendLog(
						'success',
						`Funding maintenance swap completed for ${account.label}.`,
						{
							account: account.label,
							accountKey: account.key,
							targetAsset: swapPlan.targetAsset,
							sourceAsset: swapPlan.sourceAsset,
							shortfallAmount: swapPlan.shortfallAmount,
							amountIn: result.amountIn,
							amountOut: result.amountOut,
							txDigest: result.txDigest,
							provider: result.provider
						}
					);

					await this.#refreshPostCycleFundingBalances(referencePrice);
					} catch (error) {
						const errorContext = extractErrorDebugMeta(error);
						const aggregatorContext = summarizeAggregatorDebugMeta(errorContext);
						await this.#appendLog(
							'warn',
							`Funding maintenance swap failed for ${account.label}; continuing.`,
							{
								account: account.label,
							accountKey: account.key,
								targetAsset: swapPlan.targetAsset,
								sourceAsset: swapPlan.sourceAsset,
								shortfallAmount: swapPlan.shortfallAmount,
								estimatedSourceAmount: swapPlan.estimatedSourceAmount,
								error: error instanceof Error ? error.message : String(error),
								errorContext,
								aggregatorContext
							}
						);
					}
				}

			await this.#appendLog('info', 'Post-cycle funding maintenance completed.', {
				targetCycles: POST_CYCLE_FUNDING_TARGET_CYCLES
			});
		} catch (error) {
			await this.#appendLog(
				'warn',
				'Post-cycle funding maintenance failed unexpectedly; continuing.',
				{
					error: error instanceof Error ? error.message : String(error)
				}
			);
		}
	}

	#autoBalanceBlockReason(): string | null {
		const lc = this.#snapshot.lifecycle;
		if (lc === 'RUNNING') return 'Bot is currently running. Stop the bot before auto-balancing.';
		if (lc === 'STOPPING') return 'Bot is stopping. Wait for it to finish.';
		if (this.#cleanupInProgress) return 'Cleanup is in progress. Wait for it to finish.';
		if (this.#loopPromise) return 'A cycle is active. Stop the bot first.';
		if (this.#startPromise) return 'Bot is starting. Wait for it to finish.';
		return null;
	}

	async #refreshSnapshot(): Promise<void> {
		if (!this.#db || !this.#service || !this.#accounts) {
			return;
		}

		const [stats, history, logs, runCycleCount, livePrice] = await Promise.all([
			this.#db.getDashboardStats(),
			this.#db.listRecentCycles(),
			this.#db.listLogs(),
			this.#db.countCyclesSince(this.#startedAt),
			this.#service.getLivePriceQuote(this.#accounts).catch(() => ({
				price: this.#snapshot.price.price,
				source: this.#snapshot.price.source
			}))
		]);
		const balances = await this.#service
			.getWalletBalances(this.#accounts, livePrice.price)
			.catch(() => this.#snapshot.balances);
		const preflight = this.#buildPreflightSnapshot(balances, livePrice.price);
		const liveCycleVolumeUsd =
			this.#currentCycleId !== null ? sumFilledCycleOrderVolumeUsd(this.#currentCycleOrders) : 0;
		const liveCycleFeesUsd =
			this.#currentCycleId !== null ? sumCycleOrderFeesUsd(this.#currentCycleOrders) : 0;
		const liveCycleGasUsd =
			this.#currentCycleId !== null
				? round(sumCycleOrderGasUsd(this.#currentCycleOrders) + this.#currentCycleAuxiliaryGasUsd, 6)
				: 0;
		const historyWithLiveCycle =
			this.#currentCycleId !== null
				? history.map((cycle) =>
						cycle.id === this.#currentCycleId
							? {
									...cycle,
									volumeUsd: liveCycleVolumeUsd,
									feesUsd: liveCycleFeesUsd,
									gasUsd: liveCycleGasUsd,
									orders: this.#currentCycleOrders
								}
							: cycle
					)
				: history;
		const statsWithLiveCycle =
			this.#currentCycleId !== null
				? {
						...stats,
						sessionFees: round(stats.sessionFees + liveCycleFeesUsd, 6),
						sessionGas: round(stats.sessionGas + liveCycleGasUsd, 6),
						updatedAt: nowIso()
					}
				: stats;
		const resolvedLogs = freshestLogs(this.#snapshot.logs, logs);

		this.#setSnapshot({
			runCycleCount,
			stats: statsWithLiveCycle,
			history: historyWithLiveCycle,
			logs: resolvedLogs,
			price: {
				source: livePrice.source,
				price: round(livePrice.price, 6),
				updatedAt: nowIso(),
				uptimeSeconds: Math.round((Date.now() - this.#startedAt.getTime()) / 1000)
			},
			balances,
			preflight,
			config: this.#configSummary,
			updatedAt: nowIso()
		});
	}

	async #refreshReadOnlyPrice(): Promise<void> {
		if (!this.#config) {
			return;
		}

		const service = this.#service ?? new DeepBookService(this.#config);
		const livePrice = await service.getLivePriceQuote(this.#accounts ?? {});
		const balances =
			this.#accounts && Object.keys(this.#accounts).length > 0
				? await service
						.getWalletBalances(this.#accounts, livePrice.price)
						.catch(() => this.#snapshot.balances)
				: this.#snapshot.balances;
		const preflight = this.#buildPreflightSnapshot(balances, livePrice.price);

		this.#setSnapshot({
			price: {
				source: livePrice.source,
				price: round(livePrice.price, 6),
				updatedAt: nowIso(),
				uptimeSeconds: Math.round((Date.now() - this.#startedAt.getTime()) / 1000)
			},
			balances,
			preflight,
			updatedAt: nowIso()
		});
	}

	#ensurePricePolling(): void {
		if (this.#pricePoller) {
			return;
		}

		this.#pricePoller = setInterval(() => {
			void this.#pollPriceTick();
		}, 10000);
		this.#pricePoller.unref?.();
	}

	async #pollPriceTick(): Promise<void> {
		if (this.#pricePollInFlight || this.#bootPromise) {
			return;
		}

		this.#pricePollInFlight = true;
		try {
			if (this.#db && this.#service && this.#accounts) {
				await this.#refreshSnapshot();
				return;
			}

			if (this.#config) {
				await this.#refreshReadOnlyPrice();
			}
		} finally {
			this.#pricePollInFlight = false;
		}
	}

	async #appendLog(
		level: BotLogEntry['level'],
		message: string,
		meta: Record<string, unknown>
	): Promise<void> {
		const consoleMethod = level === 'debug' ? 'log' : level === 'success' ? 'info' : level;
		console[consoleMethod](`[bot:${level}] ${message}`, meta);
		if (!this.#db) {
			return;
		}
		const entry = await this.#db.appendLog(level, message, meta);
		const nextLogs = [...this.#snapshot.logs.filter((log) => log.id !== entry.id), entry].sort(
			(left, right) => left.id - right.id
		);
		this.#snapshot.logs = nextLogs;
		this.#setSnapshot({ logs: nextLogs, updatedAt: nowIso() });
	}

	async #persistCurrentOrders(): Promise<void> {
		if (this.#currentCycleId && this.#db) {
			await this.#db.updateCycleOrders(this.#currentCycleId, this.#currentCycleOrders, {
				gasUsd: round(
					sumCycleOrderGasUsd(this.#currentCycleOrders) + this.#currentCycleAuxiliaryGasUsd,
					6
				)
			});
			await this.#refreshSnapshot();
		}
	}

	#setActiveCycle(activeCycle: ActiveCycleState): void {
		this.#setSnapshot({ activeCycle });
	}

	#setSnapshot(overrides: Partial<RuntimeSnapshot>): void {
		this.#snapshot = {
			...this.#snapshot,
			...overrides,
			updatedAt: nowIso()
		};
		this.#notify();
	}

	#notify(): void {
		const snapshot = this.getSnapshot();
		for (const subscriber of this.#subscribers) {
			subscriber(snapshot);
		}
	}

	#resetLocalState(): void {
		this.#snapshot = createSnapshot({
			lifecycle: 'STOPPED',
			liveLabel: 'Offline',
			runLabel: 'STOPPED',
			message: 'Bot stopped.',
			config: this.#configSummary,
			startedAt: this.#startedAt.toISOString(),
			runCycleCount: 0
		});
		this.#currentCycleId = null;
		this.#currentCycleAuxiliaryGasUsd = 0;
		this.#currentCycleOrders = [];
	}

	#ensureReady(): void {
		if (!this.#config || !this.#service || !this.#accounts || !this.#db) {
			throw new Error('Runtime is not initialized');
		}
	}

	#throwIfStopping(): void {
		const stopFlowActive =
			this.#snapshot.lifecycle === 'STOPPING' || Boolean(this.#loopPromise) || Boolean(this.#startPromise);
		if (this.#stopRequested && !this.#cleanupInProgress && stopFlowActive) {
			throw new StopRequestedError();
		}
	}

	#accountLabel(account: BotAccountKey): string {
		if (account === 'accountA') {
			return (
				this.#config?.account_a_label ??
				this.#configSummary?.accountALabel ??
				defaultAccountLabel(account)
			);
		}
		return (
			this.#config?.account_b_label ??
			this.#configSummary?.accountBLabel ??
			defaultAccountLabel(account)
		);
	}

	async #sleepInterruptible(ms: number): Promise<void> {
		const step = 250;
		let elapsed = 0;
		while (elapsed < ms) {
			this.#throwIfStopping();
			const wait = Math.min(step, ms - elapsed);
			await sleep(wait);
			elapsed += wait;
		}
	}

	async #randomDelay(): Promise<void> {
		if (!this.#config) {
			return;
		}
		await this.#sleepInterruptible(
			randomInt(this.#config.min_order_delay_ms, this.#config.max_order_delay_ms)
		);
	}

	async #withRetry<T>(
		label: string,
		fn: () => Promise<T>,
		maxAttempts = 3,
		meta: Record<string, unknown> = {},
		options: RetryOptions = {}
	): Promise<T> {
		const finalFailureLevel =
			options.finalFailureLevel ??
			(meta.__finalFailureLevel === 'warn' ? 'warn' : 'error');
		const minRetryDelayMs =
			typeof options.minRetryDelayMs === 'number' && Number.isFinite(options.minRetryDelayMs)
				? Math.max(0, Math.floor(options.minRetryDelayMs))
				: typeof meta.__minRetryDelayMs === 'number' && Number.isFinite(meta.__minRetryDelayMs)
					? Math.max(0, Math.floor(meta.__minRetryDelayMs))
					: 0;
		const logMeta = { ...meta };
		delete logMeta.__finalFailureLevel;
		delete logMeta.__minRetryDelayMs;

		let lastError: unknown;
		let totalAttempts = maxAttempts;
		for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
			this.#throwIfStopping();
			try {
				return await fn();
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				const isFatal = isFatalRuntimeErrorMessage(message);
				const isRateLimited = isRateLimitedErrorMessage(message);
				const errorContext = extractErrorDebugMeta(error);
				if (isRateLimited) {
					totalAttempts = Math.max(totalAttempts, 5);
				}
				await this.#appendLog(
					isFatal ? 'error' : attempt === totalAttempts ? finalFailureLevel : 'warn',
					`${label} failed.`,
					{
						...logMeta,
						attempt,
						error: message,
						errorContext
					}
				);
				if (isFatal) {
					throw new FatalRuntimeError(message, error);
				}
				if (attempt < totalAttempts) {
					const delayMs = Math.max(retryDelayMs(message, attempt), minRetryDelayMs);
					await this.#sleepInterruptible(delayMs);
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
	}

	#normalizeQuantity(quantity: number, lotSize: number, minSize: number): number {
		return normalizeQuantity(quantity, lotSize, minSize);
	}

	#normalizeCleanupQuantity(
		quantity: number,
		lotSize: number,
		minSize: number,
		options: { roundUp?: boolean; maxQuantity?: number } = {}
	): number | null {
		return normalizeCleanupQuantity(quantity, lotSize, minSize, options);
	}

	#clientOrderId(): string {
		return clientOrderId();
	}
}

type BotRuntimeGlobal = typeof globalThis & {
	__deepbookBotRuntime?: BotRuntime;
};

export function getBotRuntime(): BotRuntime {
	const globalState = globalThis as BotRuntimeGlobal;
	if (!globalState.__deepbookBotRuntime) {
		globalState.__deepbookBotRuntime = new BotRuntime();
	}
	return globalState.__deepbookBotRuntime;
}
