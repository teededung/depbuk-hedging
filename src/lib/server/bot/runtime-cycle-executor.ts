import type { AggregatorSwapResult } from './deepbook.js';
import type { BotAccountKey, CycleOrderRecord } from './types.js';
import type {
	AutoTopupPlan,
	CloseState,
	ManagedAccount,
	OpenResidualState,
	RuntimeCycleContext
} from './runtime-context.js';
import {
	clientOrderId,
	extractErrorDebugMeta,
	FatalRuntimeError,
	isFatalRuntimeErrorMessage,
	isPostOnlyCrossErrorMessage,
	isRateLimitedErrorMessage,
	makerAskPrice,
	makerBidPrice,
	normalizeQuantity,
	nowIso,
	randomBetween,
	randomInt,
	retryDelayMs,
	round,
	sumCycleOrderFeesUsd,
	sumCycleOrderGasUsd
} from './runtime-shared.js';
import { buildBlockingReason, computeEffectiveNotional } from './runtime-snapshot.js';

export class RuntimeCycleExecutor {
	#ctx: RuntimeCycleContext;

	constructor(ctx: RuntimeCycleContext) {
		this.#ctx = ctx;
	}

	#recordCurrentCycleAuxiliaryGas(gasUsedSui?: number, referencePrice?: number): void {
		if (!Number.isFinite(gasUsedSui) || !Number.isFinite(referencePrice)) {
			return;
		}
		const gasUsd = round((gasUsedSui ?? 0) * (referencePrice ?? 0), 6);
		if (gasUsd <= 0) {
			return;
		}
		this.#ctx.setCurrentCycleAuxiliaryGasUsd(
			round(this.#ctx.getCurrentCycleAuxiliaryGasUsd() + gasUsd, 6)
		);
	}

	async executeCycle(): Promise<void> {
		this.#ctx.throwIfStopping();
		const config = this.#ctx.getConfig();
		const service = this.#ctx.getService();
		const accounts = this.#ctx.getAccounts();
		const db = this.#ctx.getDb();

		const book = await this.#ctx.withRetry('load orderbook', () =>
			service.getOrderBookTop(accounts)
		);

		// Re-load wallet balances right before sizing to avoid stale snapshot funding decisions
		// after cleanup/top-up activity between cycles.
		const balances =
			typeof service.getWalletBalances === 'function'
				? await service
						.getWalletBalances(accounts, book.midPrice)
						.catch(() => this.#ctx.getSnapshot().balances)
				: this.#ctx.getSnapshot().balances;
		this.#ctx.updateBalancesAndPreflight(balances, book.midPrice);

		// Compute effective notional using shared sizing logic
		const sizing = computeEffectiveNotional({
			config,
			balances,
			referencePrice: book.midPrice
		});

		if (sizing.belowFloor) {
			throw new Error(
				`Funding short. Cannot cover even the minimum notional ($${sizing.minNotionalUsd.toFixed(2)}). Deposit required.`
			);
		}

		if (sizing.autoReduced) {
			await this.#ctx.appendLog(
				'info',
				`Funding short. Reducing cycle notional from $${sizing.configuredNotionalUsd.toFixed(2)} to $${sizing.effectiveNotionalUsd.toFixed(2)}.`,
				{
					configuredNotionalUsd: sizing.configuredNotionalUsd,
					effectiveNotionalUsd: sizing.effectiveNotionalUsd,
					minNotionalUsd: sizing.minNotionalUsd,
					autoReduced: true
				}
			);
		}

		const plannedNotionalUsd = round(
			sizing.effectiveNotionalUsd *
				(1 + randomBetween(-config.random_size_bps, config.random_size_bps) / 10000),
			4
		);
		// When auto-reduced, clamp both floor and ceiling to stay within fundable range
		const clampedPlannedNotionalUsd = sizing.autoReduced
			? round(
					Math.max(
						Math.min(plannedNotionalUsd, sizing.effectiveNotionalUsd),
						sizing.minNotionalUsd
					),
					4
				)
			: plannedNotionalUsd;
		const quantity = normalizeQuantity(
			clampedPlannedNotionalUsd / book.midPrice,
			book.lotSize,
			book.minSize
		);
		const cycleNumber = await db.getNextCycleNumber();
		const holdSecondsTarget = randomInt(config.min_hold_seconds, config.max_hold_seconds);

		this.#ctx.setCurrentCycleOrders([]);
		this.#ctx.setCurrentCycleAuxiliaryGasUsd(0);

		this.#ctx.setActiveCycle({
			cycleNumber,
			stage: 'opening',
			price: book.midPrice,
			holdSecondsTarget,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			currentQuantity: quantity,
			updatedAt: nowIso()
		});
		await Promise.all([
			this.#ctx.appendLog(
				'info',
				`Cycle #${cycleNumber} is starting for ${accounts.accountA.label}.`,
				{
					account: accounts.accountA.label,
					accountKey: 'accountA',
					cycleNumber,
					phase: 'OPEN',
					plannedNotionalUsd: clampedPlannedNotionalUsd,
					quantity,
					midPrice: book.midPrice,
					stage: 'opening'
				}
			),
			this.#ctx.appendLog(
				'info',
				`Cycle #${cycleNumber} is starting for ${accounts.accountB.label}.`,
				{
					account: accounts.accountB.label,
					accountKey: 'accountB',
					cycleNumber,
					phase: 'OPEN',
					plannedNotionalUsd: clampedPlannedNotionalUsd,
					quantity,
					midPrice: book.midPrice,
					stage: 'opening'
				}
			)
		]);
		await this.#ctx.appendLog('info', `Starting cycle #${cycleNumber}.`, {
			cycleNumber,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			quantity,
			midPrice: book.midPrice,
			stage: 'opening'
		});

		const longOpenPrice = makerBidPrice(book.bestBid, book.bestAsk, book.tickSize);
		const shortOpenPrice = makerAskPrice(book.bestBid, book.bestAsk, book.tickSize);

		const longFundingFactor = Math.max(config.account_a_borrow_quote_factor, 1);
		const shortFundingFactor = Math.max(config.account_b_borrow_base_factor, 1);

		const longCollateralUsd = round(clampedPlannedNotionalUsd / longFundingFactor, 6);
		const longDepositBase = round(longCollateralUsd / book.midPrice, 9);
		const longBorrowQuote = round(Math.max(clampedPlannedNotionalUsd - longCollateralUsd, 0), 6);
		const shortDepositQuote = round(clampedPlannedNotionalUsd / shortFundingFactor, 6);
		const shortBorrowBase = round(quantity, 9);

		const fundingPlan = await this.planWalletFundingForCycle({
			accounts,
			referencePrice: book.midPrice,
			longDepositBase,
			shortDepositQuote
		});

		const cycleId = await db.createCycle({
			cycleNumber,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			holdSecondsTarget,
			openPrice: book.midPrice,
			accountAManagerId: accounts.accountA.marginManagerId,
			accountBManagerId: accounts.accountB.marginManagerId,
			orders: []
		});
		this.#ctx.setCurrentCycleId(cycleId);

		if (fundingPlan.accountA) {
			await this.#markAutoTopupQueued(accounts.accountA, fundingPlan.accountA, cycleNumber);
		}
		const longTopUpFunding = fundingPlan.accountA
			? await this.#executeAutoTopupSwap({
					account: accounts.accountA,
					plan: fundingPlan.accountA,
					accounts,
					referencePrice: book.midPrice,
					cycleNumber
				})
			: null;
		const longOptionalQuoteDeposit =
			!fundingPlan.accountA && longBorrowQuote > 0
				? round(
						Math.min(
							Math.max(this.#ctx.getSnapshot().balances.accountA.usdc, 0),
							Math.max(0.05, longBorrowQuote * 0.01)
						),
						6
					)
				: 0;
		const longQuoteBudget = round(
			Math.max(longBorrowQuote + Math.max(longOptionalQuoteDeposit, 0), 0),
			6
		);
		const longOpenQuantity =
			config.open_order_execution_mode === 'limit' && longQuoteBudget > 0
				? normalizeQuantity(
						Math.min(quantity, longQuoteBudget / Math.max(longOpenPrice, Number.EPSILON)),
						book.lotSize,
						book.minSize
					)
				: quantity;
		const longOrder = await this.submitMakerOrder({
			account: accounts.accountA,
			side: 'LONG',
			phase: 'OPEN',
			isBid: true,
			price: longOpenPrice,
			quantity: longOpenQuantity,
			notionalUsd: round(longOpenQuantity * longOpenPrice, 4),
			depositBase: fundingPlan.accountA ? undefined : longDepositBase,
			depositQuote: longOptionalQuoteDeposit > 0 ? longOptionalQuoteDeposit : undefined,
			walletDepositBase: longTopUpFunding?.walletDepositBase,
			borrowQuote: longBorrowQuote
		});

		await this.#ctx.randomDelay();

		if (fundingPlan.accountB) {
			await this.#markAutoTopupQueued(accounts.accountB, fundingPlan.accountB, cycleNumber);
		}
		const shortTopUpFunding = fundingPlan.accountB
			? await this.#executeAutoTopupSwap({
					account: accounts.accountB,
					plan: fundingPlan.accountB,
					accounts,
					referencePrice: book.midPrice,
					cycleNumber
				})
			: null;

		const shortOrder = await this.submitMakerOrder({
			account: accounts.accountB,
			side: 'SHORT',
			phase: 'OPEN',
			isBid: false,
			price: shortOpenPrice,
			quantity,
			notionalUsd: round(quantity * shortOpenPrice, 4),
			depositQuote: fundingPlan.accountB ? undefined : shortDepositQuote,
			walletDepositQuote: shortTopUpFunding?.walletDepositQuote,
			borrowBase: shortBorrowBase
		});

		await this.#ctx.appendLog(
			'info',
			`Waiting for both open orders to fill on cycle #${cycleNumber}.`,
			{
				longOrderId: longOrder.orderId,
				shortOrderId: shortOrder.orderId
			}
		);

		this.#ctx.setActiveCycle({
			cycleNumber,
			stage: 'waiting_fill',
			price: book.midPrice,
			holdSecondsTarget,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			currentQuantity: quantity,
			updatedAt: nowIso()
		});

		const holdFillLog = (
			side: 'LONG' | 'SHORT',
			account: ManagedAccount,
			filled: { quantity: number; price: number; txDigest?: string }
		) =>
			this.#ctx.appendLog(
				'info',
				`${side} leg is filled; waiting for hold window on cycle #${cycleNumber}`,
				{
					account: account.label,
					accountKey: account.key,
					side,
					phase: 'HOLD',
					cycleNumber,
					quantity: filled.quantity,
					fillPrice: filled.price,
					txDigest: filled.txDigest
				}
			);
		const longFillPromise = this.waitForFullFill(longOrder.orderIndex, quantity).then(
			async (filled) => {
				await holdFillLog('LONG', accounts.accountA, filled);
				return filled;
			}
		);
		const shortFillPromise = this.waitForFullFill(shortOrder.orderIndex, quantity).then(
			async (filled) => {
				await holdFillLog('SHORT', accounts.accountB, filled);
				return filled;
			}
		);
		const [filledLong, filledShort] = await Promise.all([longFillPromise, shortFillPromise]);
		const openReferencePrice = round((filledLong.price + filledShort.price) / 2, 6);
		await this.settleFilledBalances(
			[
				{ account: accounts.accountA, side: 'LONG' },
				{ account: accounts.accountB, side: 'SHORT' }
			],
			cycleNumber,
			'OPEN'
		);

		const holdStartedAt = new Date();
		await db.markCycleHolding(cycleId, holdStartedAt);
		this.#ctx.setActiveCycle({
			cycleNumber,
			stage: 'holding',
			price: openReferencePrice,
			holdStartedAt: holdStartedAt.toISOString(),
			holdEndsAt: new Date(holdStartedAt.getTime() + holdSecondsTarget * 1000).toISOString(),
			holdSecondsTarget,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			currentQuantity: quantity,
			updatedAt: nowIso()
		});

		await this.#ctx.appendLog('info', `Cycle #${cycleNumber} entered holding window`, {
			holdSecondsTarget
		});
		await this.#ctx.sleepInterruptible(holdSecondsTarget * 1000);

		const closeBook = await this.#ctx.withRetry('reload orderbook for close', () =>
			service.getOrderBookTop(accounts)
		);
		const [accountAState, accountBState] = await Promise.all([
			this.loadCloseState(accounts.accountA, cycleNumber, 'LONG'),
			this.loadCloseState(accounts.accountB, cycleNumber, 'SHORT')
		]);
		const closeExecutionMode = config.close_order_execution_mode;
		const longCloseQuantity =
			closeExecutionMode === 'market'
				? null
				: this.normalizeCloseQuantityOrThrow(
						accountAState.closeQuantity,
						closeBook.lotSize,
						closeBook.minSize,
						`${this.#ctx.accountLabel('accountA')} close exposure is below pool minimum size`
					);
		const shortCloseQuantity =
			closeExecutionMode === 'market'
				? null
				: this.normalizeCloseQuantityOrThrow(
						accountBState.closeQuantity,
						closeBook.lotSize,
						closeBook.minSize,
						`${this.#ctx.accountLabel('accountB')} close exposure is below pool minimum size`
					);

		this.#ctx.setActiveCycle({
			cycleNumber,
			stage: 'closing',
			price: closeBook.midPrice,
			holdStartedAt: holdStartedAt.toISOString(),
			holdEndsAt: new Date(holdStartedAt.getTime() + holdSecondsTarget * 1000).toISOString(),
			holdSecondsTarget,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			currentQuantity: quantity,
			updatedAt: nowIso()
		});

		const longClose =
			closeExecutionMode === 'market'
				? await this.submitLongCloseMarketOrder({
						account: accounts.accountA,
						closeState: accountAState,
						referencePrice: closeBook.midPrice
					})
				: await this.submitMakerOrder({
						account: accounts.accountA,
						side: 'LONG',
						phase: 'CLOSE',
						isBid: false,
						price: makerAskPrice(closeBook.bestBid, closeBook.bestAsk, closeBook.tickSize),
						quantity: longCloseQuantity!,
						notionalUsd: round(longCloseQuantity! * closeBook.midPrice, 4)
					});

		await this.#ctx.randomDelay();

		const shortClose =
			closeExecutionMode === 'market'
				? await this.submitShortCloseMarketOrder({
						account: accounts.accountB,
						closeState: accountBState,
						referencePrice: closeBook.midPrice
					})
				: await this.submitMakerOrder({
						account: accounts.accountB,
						side: 'SHORT',
						phase: 'CLOSE',
						isBid: true,
						price: makerBidPrice(closeBook.bestBid, closeBook.bestAsk, closeBook.tickSize),
						quantity: shortCloseQuantity!,
						notionalUsd: round(shortCloseQuantity! * closeBook.midPrice, 4)
					});

		const closedLong = await this.waitForFullFill(
			longClose.orderIndex,
			longCloseQuantity ?? accountAState.closeQuantity
		);
		const closedShort = await this.waitForFullFill(
			shortClose.orderIndex,
			shortCloseQuantity ?? accountBState.closeQuantity
		);
		const closeReferencePrice = round((closedLong.price + closedShort.price) / 2, 6);
		await this.settleFilledBalances(
			[
				{ account: accounts.accountA, side: 'LONG' },
				{ account: accounts.accountB, side: 'SHORT' }
			],
			cycleNumber,
			'CLOSE'
		);
		if (closeExecutionMode === 'limit') {
			await this.repayLimitCloseResiduals(
				[
					{ account: accounts.accountA, side: 'LONG' },
					{ account: accounts.accountB, side: 'SHORT' }
				],
				cycleNumber
			);
		}
		await this.verifyPostCloseReadiness(
			[
				{ account: accounts.accountA, side: 'LONG' },
				{ account: accounts.accountB, side: 'SHORT' }
			],
			cycleNumber
		);

		await this.#ctx.appendLog('info', `Cycle #${cycleNumber} close orders filled.`, {
			closeReferencePrice
		});
		await Promise.all([
			this.#ctx.appendLog('success', `LONG leg completed on cycle #${cycleNumber}.`, {
				account: accounts.accountA.label,
				accountKey: 'accountA',
				side: 'LONG',
				phase: 'CLOSE',
				cycleNumber,
				quantity: closedLong.quantity,
				fillPrice: closedLong.price,
				txDigest: closedLong.txDigest
			}),
			this.#ctx.appendLog('success', `SHORT leg completed on cycle #${cycleNumber}.`, {
				account: accounts.accountB.label,
				accountKey: 'accountB',
				side: 'SHORT',
				phase: 'CLOSE',
				cycleNumber,
				quantity: closedShort.quantity,
				fillPrice: closedShort.price,
				txDigest: closedShort.txDigest
			})
		]);

		this.#ctx.setActiveCycle({
			cycleNumber,
			stage: 'cleanup',
			price: closeReferencePrice,
			holdStartedAt: holdStartedAt.toISOString(),
			holdEndsAt: new Date(holdStartedAt.getTime() + holdSecondsTarget * 1000).toISOString(),
			holdSecondsTarget,
			plannedNotionalUsd: clampedPlannedNotionalUsd,
			currentQuantity: quantity,
			updatedAt: nowIso()
		});

		const orders = this.#ctx.getCurrentCycleOrders();
		const feesUsd = sumCycleOrderFeesUsd(orders);
		const gasUsd = round(
			sumCycleOrderGasUsd(orders) + this.#ctx.getCurrentCycleAuxiliaryGasUsd(),
			6
		);
		const matchedLongQuantity = Math.min(filledLong.quantity, closedLong.quantity);
		const matchedShortQuantity = Math.min(filledShort.quantity, closedShort.quantity);
		const realizedTradingPnlUsd = round(
			matchedLongQuantity * (closedLong.price - filledLong.price) +
				matchedShortQuantity * (filledShort.price - closedShort.price),
			6
		);
		const volumeUsd = round(
			filledLong.quantity * filledLong.price +
				filledShort.quantity * filledShort.price +
				closedLong.quantity * closedLong.price +
				closedShort.quantity * closedShort.price,
			4
		);
		const holdSecondsActual = Math.round((Date.now() - holdStartedAt.getTime()) / 1000);

		for (const order of orders) {
			order.status = order.status === 'open' ? 'filled' : order.status;
		}
		await db.updateCycleOrders(cycleId, orders, {
			gasUsd
		});
		await db.finishCycle(cycleId, {
			status: 'completed',
			volumeUsd,
			feesUsd,
			gasUsd,
			pnlUsd: round(realizedTradingPnlUsd - feesUsd - gasUsd, 6),
			holdSecondsActual,
			closePrice: closeReferencePrice,
			orders
		});

		this.#ctx.setCurrentCycleId(null);
		this.#ctx.setCurrentCycleAuxiliaryGasUsd(0);
		this.#ctx.setCurrentCycleOrders([]);
		await this.#ctx.refreshSnapshot();
		this.#ctx.setSnapshot({
			activeCycle: null,
			message: `Cycle #${cycleNumber} completed successfully.`
		});
		await this.#ctx.appendLog('info', `Cycle #${cycleNumber} completed.`, {
			volumeUsd,
			feesUsd,
			gasUsd
		});
	}

	async planWalletFundingForCycle(input: {
		accounts: Record<BotAccountKey, ManagedAccount>;
		referencePrice: number;
		longDepositBase: number;
		shortDepositQuote: number;
	}): Promise<{ accountA: AutoTopupPlan | null; accountB: AutoTopupPlan | null }> {
		const config = this.#ctx.getConfig();
		const service = this.#ctx.getService();
		if (!config.auto_swap_enabled) {
			return {
				accountA: null,
				accountB: null
			};
		}

		const { accounts, referencePrice, longDepositBase, shortDepositQuote } = input;
		const safetyMultiplier =
			1 + config.auto_swap_buffer_bps / 10000 + Math.max(config.slippage_tolerance, 0);
		const balances = await service.getWalletBalances(accounts, referencePrice);
		this.#ctx.updateBalancesAndPreflight(balances, referencePrice);
		let accountBPlan: AutoTopupPlan | null = null;
		let accountAPlan: AutoTopupPlan | null = null;

		const requiredAccountBUsdc = round(
			shortDepositQuote * (1 + config.auto_swap_buffer_bps / 10000),
			6
		);
		if (balances.accountB.usdc + 1e-9 < requiredAccountBUsdc) {
			const shortfallUsdc = round(requiredAccountBUsdc - balances.accountB.usdc, 6);
			const estimatedSuiIn = round((shortfallUsdc / referencePrice) * safetyMultiplier, 9);
			const availableSuiForSwap = Math.max(balances.accountB.sui - config.min_gas_reserve_sui, 0);
			if (availableSuiForSwap + 1e-9 < estimatedSuiIn) {
				throw new Error(
					`Account B needs ${requiredAccountBUsdc.toFixed(4)} USDC but only has ${balances.accountB.usdc.toFixed(4)} USDC and ${balances.accountB.sui.toFixed(4)} SUI available`
				);
			}

			accountBPlan = {
				account: 'accountB',
				reason: 'insufficient_usdc',
				coinIn: 'SUI',
				coinOut: 'USDC',
				coinTypeIn: service.coins.SUI.type,
				coinTypeOut: service.coins.USDC.type,
				amountIn: estimatedSuiIn,
				requiredAmount: requiredAccountBUsdc,
				currentAmount: balances.accountB.usdc,
				walletDepositAmount: round(shortDepositQuote, 6)
			};
		}

		const availableAccountASui = round(
			Math.max(balances.accountA.sui - config.min_gas_reserve_sui, 0),
			9
		);
		const requiredAccountASui = round(
			longDepositBase * (1 + config.auto_swap_buffer_bps / 10000),
			9
		);
		if (availableAccountASui + 1e-9 < requiredAccountASui) {
			const shortfallSui = round(requiredAccountASui - availableAccountASui, 9);
			const estimatedUsdcIn = round(shortfallSui * referencePrice * safetyMultiplier, 6);
			if (balances.accountA.usdc + 1e-9 < estimatedUsdcIn) {
				throw new Error(
					`Account A needs ${requiredAccountASui.toFixed(4)} SUI but only has ${availableAccountASui.toFixed(4)} SUI and ${balances.accountA.usdc.toFixed(4)} USDC available`
				);
			}

			accountAPlan = {
				account: 'accountA',
				reason: 'insufficient_sui',
				coinIn: 'USDC',
				coinOut: 'SUI',
				coinTypeIn: service.coins.USDC.type,
				coinTypeOut: service.coins.SUI.type,
				amountIn: estimatedUsdcIn,
				requiredAmount: requiredAccountASui,
				currentAmount: availableAccountASui,
				walletDepositAmount: round(longDepositBase, 9)
			};
		}

		return {
			accountA: accountAPlan,
			accountB: accountBPlan
		};
	}

	async settleFilledBalances(
		entries: Array<{ account: ManagedAccount; side: 'LONG' | 'SHORT' }>,
		cycleNumber: number,
		phase: 'OPEN' | 'CLOSE'
	): Promise<void> {
		const service = this.#ctx.getService();
		const withdrawResults = await Promise.all(
			entries.map(({ account, side }) =>
				this.#ctx.withRetry(
					'withdraw settled amounts after fill',
					() => service.withdrawSettled(account),
					3,
					{
						account: account.label,
						side,
						phase,
						cycleNumber
					},
					{
						minRetryDelayMs: 2500
					}
				)
			)
		);
		for (const [index, result] of withdrawResults.entries()) {
			const { account, side } = entries[index];
			this.#recordCurrentCycleAuxiliaryGas(
				result?.gasUsedSui,
				this.#ctx.getSnapshot().price.price
			);
			await this.#ctx.appendLog('info', 'withdraw settled amounts after fill succeeded.', {
				account: account.label,
				accountKey: account.key,
				side,
				phase,
				cycleNumber,
				txDigest: result?.txDigest,
				gasUsedSui: round(result?.gasUsedSui ?? 0, 9),
				gasUsedUsd: round((result?.gasUsedSui ?? 0) * this.#ctx.getSnapshot().price.price, 6)
			});
		}
	}

	async verifyPostCloseReadiness(
		entries: Array<{ account: ManagedAccount; side: 'LONG' | 'SHORT' }>,
		cycleNumber: number
	): Promise<void> {
		const service = this.#ctx.getService();
		const checks = await Promise.all(
			entries.map(async ({ account, side }) => {
				const [openOrders, managerState] = await Promise.all([
					this.#ctx.withRetry(
						'load open orders for post-close verification',
						() => service.getAccountOpenOrders(account),
						3,
						{
							account: account.label,
							accountKey: account.key,
							side,
							phase: 'CLOSE',
							cycleNumber
						}
					),
					this.#ctx.withRetry(
						'load manager state for post-close verification',
						() => service.getMarginManagerState(account),
						3,
						{
							account: account.label,
							accountKey: account.key,
							side,
							phase: 'CLOSE',
							cycleNumber
						}
					)
				]);
				const snapshot = {
					openOrdersCount: openOrders.length,
					baseAsset: Math.max(managerState.baseAsset, 0),
					quoteAsset: Math.max(managerState.quoteAsset, 0),
					baseDebt: Math.max(managerState.baseDebt, 0),
					quoteDebt: Math.max(managerState.quoteDebt, 0)
				};
				const blockingReason = buildBlockingReason({
					...snapshot,
					isBlocked: false
				});
				return {
					account,
					side,
					snapshot,
					blockingReason
				};
			})
		);
		const blocked = checks.filter((entry) => Boolean(entry.blockingReason));
		if (blocked.length === 0) {
			return;
		}

		const residuals = blocked.map((entry) => ({
			account: entry.account.label,
			accountKey: entry.account.key,
			side: entry.side,
			reason: entry.blockingReason,
			...entry.snapshot
		}));
		await this.#ctx.appendLog(
			'error',
			`Cycle #${cycleNumber} close verification failed: residual margin state still present.`,
			{
				cycleNumber,
				residuals
			}
		);
		const reason = blocked
			.map((entry) => `${entry.account.label}: ${entry.blockingReason ?? 'unknown residual state'}`)
			.join(' | ');
		throw new Error(`Cycle #${cycleNumber} close verification failed: ${reason}`);
	}

	async repayLimitCloseResiduals(
		entries: Array<{ account: ManagedAccount; side: 'LONG' | 'SHORT' }>,
		cycleNumber: number
	): Promise<void> {
		const service = this.#ctx.getService();
		// Keep close-repay retries short in count but rely on delay backoff for
		// transient "not withdrawable yet" manager states.
		const maxAttempts = 3;
		const repayResults = await Promise.all(
			entries.map(({ account, side }) =>
				this.#ctx.withRetry(
					'repay residual debts after limit close fills',
					() => service.repayFromManagerAndWithdraw(account),
					maxAttempts,
					{
						account: account.label,
						accountKey: account.key,
						side,
						phase: 'CLOSE',
						cycleNumber
					}
				)
			)
		);

		await Promise.all(
			entries.map(async ({ account, side }, index) => {
				const result = repayResults[index];
				this.#recordCurrentCycleAuxiliaryGas(
					result?.gasUsedSui,
					this.#ctx.getSnapshot().price.price
				);
				await this.#ctx.appendLog(
					'info',
					`${side} close repay-withdraw synced manager balances after limit fill.`,
					{
						account: account.label,
						accountKey: account.key,
						side,
						phase: 'CLOSE',
						cycleNumber,
						txDigest: result?.txDigest,
						gasUsedSui: round(result?.gasUsedSui ?? 0, 9),
						gasUsedUsd: round(
							(result?.gasUsedSui ?? 0) * this.#ctx.getSnapshot().price.price,
							6
						),
						executionMode: 'limit'
					}
				);
			})
		);
	}

	async loadCloseState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT'
	): Promise<CloseState> {
		return this.#loadCloseState(
			account,
			cycleNumber,
			side,
			'load close preparation state',
			`${side} close state prepared`
		);
	}

	async reloadCloseResidualState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT'
	): Promise<CloseState> {
		return this.#loadCloseState(
			account,
			cycleNumber,
			side,
			'reload close residual state',
			`${side} close residual recalculated from manager state.`
		);
	}

	async #loadCloseState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT',
		retryLabel: string,
		logMessage: string
	): Promise<CloseState> {
		const state = await this.#ctx.withRetry(
			retryLabel,
			() => this.#ctx.getService().getMarginManagerState(account),
			3,
			{
				account: account.label,
				side,
				phase: 'CLOSE',
				cycleNumber
			}
		);

		// SHORT targets the full baseDebt, not baseDebt - baseAsset.
		const closeQuantity =
			side === 'LONG' ? Math.max(state.baseAsset, 0) : Math.max(state.baseDebt, 0);

		await this.#ctx.appendLog('info', logMessage, {
			account: account.label,
			accountKey: account.key,
			side,
			phase: 'CLOSE',
			cycleNumber,
			baseAsset: round(state.baseAsset, 9),
			quoteAsset: round(state.quoteAsset, 6),
			baseDebt: round(state.baseDebt, 9),
			quoteDebt: round(state.quoteDebt, 6),
			closeQuantity: round(closeQuantity, 9),
			referencePrice: round(state.currentPrice, 6)
		});

		return { state, closeQuantity };
	}

	async reloadOpenResidualState(
		account: ManagedAccount,
		cycleNumber: number,
		side: 'LONG' | 'SHORT',
		targetQuantity: number,
		orderPrice: number
	): Promise<OpenResidualState> {
		const state = await this.#ctx.withRetry(
			'reload open residual state',
			() => this.#ctx.getService().getMarginManagerState(account),
			3,
			{
				account: account.label,
				side,
				phase: 'OPEN',
				cycleNumber
			}
		);

		const residualQuantity =
			side === 'LONG'
				? Math.max(
						Math.min(
							Math.max(targetQuantity - state.baseAsset, 0),
							orderPrice > 0
								? Math.max(state.quoteAsset, 0) / orderPrice
								: Math.max(targetQuantity - state.baseAsset, 0)
						),
						0
					)
				: Math.max(
						Math.min(
							Math.max(targetQuantity - Math.max(state.baseDebt - state.baseAsset, 0), 0),
							Math.max(state.baseAsset, 0)
						),
						0
					);

		await this.#ctx.appendLog('info', `${side} open residual recalculated from manager state.`, {
			account: account.label,
			accountKey: account.key,
			side,
			phase: 'OPEN',
			cycleNumber,
			baseAsset: round(state.baseAsset, 9),
			quoteAsset: round(state.quoteAsset, 6),
			baseDebt: round(state.baseDebt, 9),
			quoteDebt: round(state.quoteDebt, 6),
			residualQuantity: round(residualQuantity, 9),
			orderPrice: round(orderPrice, 6),
			referencePrice: round(state.currentPrice, 6)
		});

		return { state, residualQuantity };
	}

	normalizeCloseQuantityOrThrow(
		quantity: number,
		lotSize: number,
		minSize: number,
		message: string
	): number {
		try {
			return normalizeQuantity(quantity, lotSize, minSize);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === 'Configured notional is smaller than pool minimum size'
			) {
				throw new Error(message);
			}
			throw error;
		}
	}

	async submitLongCloseMarketOrder(input: {
		account: ManagedAccount;
		closeState: CloseState;
		referencePrice: number;
	}): Promise<{ orderIndex: number; orderId: string; price: number }> {
		this.#ctx.throwIfStopping();

		const orders = this.#ctx.getCurrentCycleOrders();
		const attempt =
			orders.filter((order) => order.account === input.account.key && order.phase === 'CLOSE')
				.length + 1;
		const netQuoteDebt = round(
			Math.max(input.closeState.state.quoteDebt - input.closeState.state.quoteAsset, 0),
			6
		);
		const record: CycleOrderRecord = {
			account: input.account.key,
			side: 'LONG',
			phase: 'CLOSE',
			isBid: false,
			reduceOnly: false,
			clientOrderId: clientOrderId(),
			price: input.referencePrice,
			quantity: input.closeState.closeQuantity,
			notionalUsd: round(input.closeState.closeQuantity * input.referencePrice, 4),
			status: 'pending',
			attempt
		};
		orders.push(record);
		await this.#ctx.persistCurrentOrders();

		let totalAttempts = 3;
		let lastError: unknown;

		for (let submitAttempt = 1; submitAttempt <= totalAttempts; submitAttempt += 1) {
			this.#ctx.throwIfStopping();
			try {
				const service = this.#ctx.getService();
				const result = await service.placeLongCloseMarketOrderAndRepayQuote({
					account: input.account,
					clientOrderId: record.clientOrderId,
					targetQuoteDebt: input.closeState.state.quoteDebt,
					maxBaseQuantity: input.closeState.state.baseAsset
				});
				const computedSellQuantity = round(result.computedSellQuantity ?? 0, 9);
				const actualFilledQuantity = round(result.filledQuantity ?? computedSellQuantity, 9);
				const actualFilledPrice = round(result.averageFillPrice ?? input.referencePrice, 6);

				record.price = actualFilledPrice;
				record.quantity = actualFilledQuantity;
				record.notionalUsd = round(actualFilledPrice * actualFilledQuantity, 4);
				record.txDigest = result.txDigest;
				record.orderId = result.orderId ?? record.clientOrderId;
				record.gasUsedSui = round(result.gasUsedSui ?? 0, 9);
				record.gasUsedUsd = round((result.gasUsedSui ?? 0) * actualFilledPrice, 6);
				record.paidFeesQuote = round(result.paidFeesQuote ?? 0, 6);
				record.paidFeesAmount = round(result.paidFeesAmount ?? 0, 9);
				record.paidFeesAsset = result.paidFeesAsset ?? null;
				record.status = 'filled';
				record.filledPrice = actualFilledPrice;
				record.filledQuantity = actualFilledQuantity;
				record.filledAt = nowIso();
				await this.#ctx.persistCurrentOrders();

				await this.#ctx.appendLog('info', 'LONG close market submitted.', {
					account: input.account.label,
					accountKey: input.account.key,
					side: 'LONG',
					phase: 'CLOSE',
					cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
					price: actualFilledPrice,
					quantity: actualFilledQuantity,
					filledPrice: actualFilledPrice,
					filledQuantity: actualFilledQuantity,
					computedSellQuantity,
					targetQuoteDebt: round(input.closeState.state.quoteDebt, 6),
					netQuoteDebt: round(result.netQuoteDebt ?? netQuoteDebt, 6),
					orderId: record.orderId,
					txDigest: record.txDigest,
					gasUsedSui: record.gasUsedSui,
					gasUsedUsd: record.gasUsedUsd,
					paidFeesQuote: record.paidFeesQuote,
					paidFeesAmount: record.paidFeesAmount,
					paidFeesAsset: record.paidFeesAsset,
					executionMode: 'market'
				});

				return {
					orderIndex: this.#ctx.getCurrentCycleOrders().length - 1,
					orderId: record.orderId,
					price: actualFilledPrice
				};
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				const errorContext = extractErrorDebugMeta(error);
				const isFatal = isFatalRuntimeErrorMessage(message);
				const isRateLimited = isRateLimitedErrorMessage(message);
				if (isRateLimited) {
					totalAttempts = Math.max(totalAttempts, 5);
				}

				await this.#ctx.appendLog(
					isFatal || submitAttempt === totalAttempts ? 'error' : 'warn',
					'LONG close market order failed.',
					{
						account: input.account.label,
						accountKey: input.account.key,
						side: 'LONG',
						phase: 'CLOSE',
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
						attempt: submitAttempt,
						error: message,
						errorContext,
						targetQuoteDebt: round(input.closeState.state.quoteDebt, 6),
						netQuoteDebt,
						maxBaseQuantity: round(input.closeState.state.baseAsset, 9),
						executionMode: 'market'
					}
				);

				if (isFatal) {
					throw new FatalRuntimeError(message, error);
				}

				if (submitAttempt < totalAttempts) {
					await this.#ctx.sleepInterruptible(retryDelayMs(message, submitAttempt));
				}
			}
		}

		record.status = 'failed';
		await this.#ctx.persistCurrentOrders();
		throw lastError instanceof Error ? lastError : new Error('LONG close market order failed');
	}

	async submitShortCloseMarketOrder(input: {
		account: ManagedAccount;
		closeState: CloseState;
		referencePrice: number;
	}): Promise<{ orderIndex: number; orderId: string; price: number }> {
		this.#ctx.throwIfStopping();

		const orders = this.#ctx.getCurrentCycleOrders();
		const attempt =
			orders.filter((order) => order.account === input.account.key && order.phase === 'CLOSE')
				.length + 1;
		const targetBaseDebt = round(Math.max(input.closeState.state.baseDebt, 0), 9);
		const record: CycleOrderRecord = {
			account: input.account.key,
			side: 'SHORT',
			phase: 'CLOSE',
			isBid: true,
			reduceOnly: false,
			clientOrderId: clientOrderId(),
			price: input.referencePrice,
			quantity: input.closeState.closeQuantity,
			notionalUsd: round(input.closeState.closeQuantity * input.referencePrice, 4),
			status: 'pending',
			attempt
		};
		orders.push(record);
		await this.#ctx.persistCurrentOrders();

		let totalAttempts = 3;
		let lastError: unknown;

		for (let submitAttempt = 1; submitAttempt <= totalAttempts; submitAttempt += 1) {
			this.#ctx.throwIfStopping();
			try {
				const service = this.#ctx.getService();
				const result = await service.placeShortCloseMarketOrderAndRepayBase({
					account: input.account,
					clientOrderId: record.clientOrderId,
					targetBaseDebt: input.closeState.state.baseDebt,
					maxQuoteQuantity: input.closeState.state.quoteAsset
				});
				const computedBuyQuantity = round(result.computedBuyQuantity ?? 0, 9);
				const actualFilledQuantity = round(result.filledQuantity ?? computedBuyQuantity, 9);
				const actualFilledPrice = round(result.averageFillPrice ?? input.referencePrice, 6);

				record.price = actualFilledPrice;
				record.quantity = actualFilledQuantity;
				record.notionalUsd = round(actualFilledPrice * actualFilledQuantity, 4);
				record.txDigest = result.txDigest;
				record.orderId = result.orderId ?? record.clientOrderId;
				record.gasUsedSui = round(result.gasUsedSui ?? 0, 9);
				record.gasUsedUsd = round((result.gasUsedSui ?? 0) * actualFilledPrice, 6);
				record.paidFeesQuote = round(result.paidFeesQuote ?? 0, 6);
				record.paidFeesAmount = round(result.paidFeesAmount ?? 0, 9);
				record.paidFeesAsset = result.paidFeesAsset ?? null;
				record.status = 'filled';
				record.filledPrice = actualFilledPrice;
				record.filledQuantity = actualFilledQuantity;
				record.filledAt = nowIso();
				await this.#ctx.persistCurrentOrders();

				await this.#ctx.appendLog('info', 'SHORT close market submitted.', {
					account: input.account.label,
					accountKey: input.account.key,
					side: 'SHORT',
					phase: 'CLOSE',
					cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
					price: actualFilledPrice,
					quantity: actualFilledQuantity,
					filledPrice: actualFilledPrice,
					filledQuantity: actualFilledQuantity,
					computedBuyQuantity,
					targetBaseDebt,
					baseAssetBeforeClose: round(input.closeState.state.baseAsset, 9),
					quoteAssetBeforeClose: round(input.closeState.state.quoteAsset, 6),
					computedQuoteBudget: round(result.computedQuoteBudget ?? 0, 6),
					repayMode: 'all_available',
					orderId: record.orderId,
					txDigest: record.txDigest,
					gasUsedSui: record.gasUsedSui,
					gasUsedUsd: record.gasUsedUsd,
					paidFeesQuote: record.paidFeesQuote,
					paidFeesAmount: record.paidFeesAmount,
					paidFeesAsset: record.paidFeesAsset,
					executionMode: 'market'
				});

				return {
					orderIndex: this.#ctx.getCurrentCycleOrders().length - 1,
					orderId: record.orderId,
					price: actualFilledPrice
				};
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				const errorContext = extractErrorDebugMeta(error);
				const isFatal = isFatalRuntimeErrorMessage(message);
				const isRateLimited = isRateLimitedErrorMessage(message);
				if (isRateLimited) {
					totalAttempts = Math.max(totalAttempts, 5);
				}

				await this.#ctx.appendLog(
					isFatal || submitAttempt === totalAttempts ? 'error' : 'warn',
					'SHORT close market order failed.',
					{
						account: input.account.label,
						accountKey: input.account.key,
						side: 'SHORT',
						phase: 'CLOSE',
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
						attempt: submitAttempt,
						error: message,
						errorContext,
						targetBaseDebt,
						baseAssetBeforeClose: round(input.closeState.state.baseAsset, 9),
						quoteAssetBeforeClose: round(input.closeState.state.quoteAsset, 6),
						computedBuyQuantity: round(input.closeState.closeQuantity, 9),
						repayMode: 'all_available',
						executionMode: 'market'
					}
				);

				if (isFatal) {
					throw new FatalRuntimeError(message, error);
				}

				if (submitAttempt < totalAttempts) {
					await this.#ctx.sleepInterruptible(retryDelayMs(message, submitAttempt));
				}
			}
		}

		record.status = 'failed';
		await this.#ctx.persistCurrentOrders();
		throw lastError instanceof Error ? lastError : new Error('SHORT close market order failed');
	}

	async submitMakerOrder(input: {
		account: ManagedAccount;
		side: 'LONG' | 'SHORT';
		phase: 'OPEN' | 'CLOSE';
		isBid: boolean;
		price: number;
		quantity: number;
		notionalUsd: number;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}): Promise<{ orderIndex: number; orderId: string; price: number }> {
		this.#ctx.throwIfStopping();

		const runtimeConfig = this.#ctx.getConfig();
		const executionMode =
			input.phase === 'OPEN'
				? runtimeConfig.open_order_execution_mode
				: runtimeConfig.close_order_execution_mode;
		const orders = this.#ctx.getCurrentCycleOrders();
		const attempt =
			orders.filter((order) => order.account === input.account.key && order.phase === input.phase)
				.length + 1;
		const record: CycleOrderRecord = {
			account: input.account.key,
			side: input.side,
			phase: input.phase,
			isBid: input.isBid,
			reduceOnly: false,
			clientOrderId: clientOrderId(),
			price: input.price,
			quantity: input.quantity,
			notionalUsd: input.notionalUsd,
			status: 'pending',
			attempt
		};
		orders.push(record);
		await this.#ctx.persistCurrentOrders();

		let currentPrice = input.price;
		let currentNotionalUsd = input.notionalUsd;
		let totalAttempts = 3;
		let lastError: unknown;

		for (let submitAttempt = 1; submitAttempt <= totalAttempts; submitAttempt += 1) {
			this.#ctx.throwIfStopping();
			try {
				const service = this.#ctx.getService();
				const useDeeptradeStyleLongOpenLimitPath =
					runtimeConfig.experimental_deeptrade_limit_ptb &&
					executionMode === 'limit' &&
					input.phase === 'OPEN' &&
					input.side === 'LONG';
				const hasPriorSuccessfulOpenSubmit = orders.some(
					(order) =>
						order !== record &&
						order.account === input.account.key &&
						order.side === input.side &&
						order.phase === 'OPEN' &&
						order.status !== 'pending' &&
						order.status !== 'failed'
				);
				const shouldSetMarginManagerReferral =
					input.phase === 'OPEN' && !hasPriorSuccessfulOpenSubmit;
				const knownOpenOrderIds =
					executionMode === 'limit'
						? await service.getAccountOpenOrders(input.account).catch(() => [])
						: [];
				if (useDeeptradeStyleLongOpenLimitPath) {
					await this.#ctx.appendLog(
						'info',
						`${input.side} ${input.phase.toLowerCase()} using DeepTrade-style long submit path.`,
						{
							accountKey: input.account.key,
							account: input.account.label,
							cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
							side: input.side,
							phase: input.phase
						}
					);
				}
				const result =
					executionMode === 'market'
						? await service.placeMarginMarketOrder({
								account: input.account,
								clientOrderId: record.clientOrderId,
								quantity: input.quantity,
								isBid: input.isBid,
								setMarginManagerReferral: shouldSetMarginManagerReferral,
								depositBase: input.depositBase,
								depositQuote: input.depositQuote,
								walletDepositBase: input.walletDepositBase,
								walletDepositQuote: input.walletDepositQuote,
								borrowBase: input.borrowBase,
								borrowQuote: input.borrowQuote
							})
						: useDeeptradeStyleLongOpenLimitPath
							? typeof service.placeMarginLimitOrderDeeptradeStyle === 'function'
								? await service.placeMarginLimitOrderDeeptradeStyle({
										account: input.account,
										clientOrderId: record.clientOrderId,
										price: currentPrice,
										quantity: input.quantity,
										isBid: input.isBid,
										setMarginManagerReferral: shouldSetMarginManagerReferral,
										depositBase: input.depositBase,
										depositQuote: input.depositQuote,
										walletDepositBase: input.walletDepositBase,
										walletDepositQuote: input.walletDepositQuote,
										borrowBase: input.borrowBase,
										borrowQuote: input.borrowQuote
									})
								: await service.placeMarginLimitOrder({
										account: input.account,
										clientOrderId: record.clientOrderId,
										price: currentPrice,
										quantity: input.quantity,
										isBid: input.isBid,
										setMarginManagerReferral: shouldSetMarginManagerReferral,
										depositBase: input.depositBase,
										depositQuote: input.depositQuote,
										walletDepositBase: input.walletDepositBase,
										walletDepositQuote: input.walletDepositQuote,
										borrowBase: input.borrowBase,
										borrowQuote: input.borrowQuote
									})
							: await service.placeMarginLimitOrder({
									account: input.account,
									clientOrderId: record.clientOrderId,
									price: currentPrice,
									quantity: input.quantity,
									isBid: input.isBid,
									setMarginManagerReferral: shouldSetMarginManagerReferral,
									depositBase: input.depositBase,
									depositQuote: input.depositQuote,
									walletDepositBase: input.walletDepositBase,
									walletDepositQuote: input.walletDepositQuote,
									borrowBase: input.borrowBase,
									borrowQuote: input.borrowQuote
								});

				const marketFilledPrice = result.averageFillPrice ?? currentPrice;
				const marketFilledQuantity = result.filledQuantity ?? input.quantity;
				record.price = currentPrice;
				record.quantity = input.quantity;
				record.notionalUsd = currentNotionalUsd;
				record.txDigest = result.txDigest;
				record.orderId =
					executionMode === 'market'
						? (result.orderId ?? record.clientOrderId)
						: (result.orderId ??
							(await this.reconcileSubmittedOrderId(
								input.account,
								record.clientOrderId,
								result.txDigest,
								knownOpenOrderIds,
								{
									side: input.side,
									phase: input.phase,
									cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber
								}
							)));
				record.gasUsedSui = round(result.gasUsedSui ?? 0, 9);
				record.gasUsedUsd = round((result.gasUsedSui ?? 0) * marketFilledPrice, 6);
				record.paidFeesQuote = round(result.paidFeesQuote ?? 0, 6);
				record.paidFeesAmount = round(result.paidFeesAmount ?? 0, 9);
				record.paidFeesAsset = result.paidFeesAsset ?? null;
				if (executionMode === 'market') {
					record.price = round(marketFilledPrice, 6);
					record.quantity = round(marketFilledQuantity, 9);
					record.status = 'filled';
					record.filledPrice = round(marketFilledPrice, 6);
					record.filledQuantity = round(marketFilledQuantity, 9);
					record.notionalUsd = round(marketFilledPrice * marketFilledQuantity, 4);
					record.filledAt = nowIso();
				} else {
					record.status = 'open';
				}
				await this.#ctx.persistCurrentOrders();

				await this.#ctx.appendLog(
					'info',
					`${input.side} ${input.phase.toLowerCase()} ${executionMode === 'market' ? 'market' : 'order'} submitted.`,
					{
						account: input.account.label,
						accountKey: input.account.key,
						side: input.side,
						phase: input.phase,
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
						price: record.price,
						quantity: record.quantity,
						filledPrice: executionMode === 'market' ? record.filledPrice : undefined,
						filledQuantity: executionMode === 'market' ? record.filledQuantity : undefined,
						orderId: record.orderId,
						txDigest: record.txDigest,
						gasUsedSui: record.gasUsedSui,
						gasUsedUsd: record.gasUsedUsd,
						paidFeesQuote: record.paidFeesQuote,
						paidFeesAmount: record.paidFeesAmount,
						paidFeesAsset: record.paidFeesAsset,
						executionMode
					}
				);

				if (!record.orderId && executionMode === 'limit') {
					throw new Error(
						`Order placement for ${input.side} ${input.phase} did not return an order id after reconciling txDigest ${result.txDigest}`
					);
				}
				const submittedOrderId = record.orderId ?? record.clientOrderId;

				return {
					orderIndex: this.#ctx.getCurrentCycleOrders().length - 1,
					orderId: submittedOrderId,
					price: executionMode === 'market' ? round(marketFilledPrice, 6) : currentPrice
				};
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				const errorContext = extractErrorDebugMeta(error);
				const isFatal = isFatalRuntimeErrorMessage(message);
				const isRateLimited = isRateLimitedErrorMessage(message);
				const isPostOnlyCross = executionMode === 'limit' && isPostOnlyCrossErrorMessage(message);
				if (isRateLimited || isPostOnlyCross) {
					totalAttempts = Math.max(totalAttempts, 5);
				}

				await this.#ctx.appendLog(
					isFatal || submitAttempt === totalAttempts ? 'error' : 'warn',
					`${input.side} ${input.phase.toLowerCase()} ${executionMode === 'market' ? 'market order' : 'maker order'} failed.`,
					{
						account: input.account.label,
						accountKey: input.account.key,
						side: input.side,
						phase: input.phase,
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
						attempt: submitAttempt,
						error: message,
						errorContext,
						executionMode
					}
				);

				if (isFatal) {
					throw new FatalRuntimeError(message, error);
				}

				if (submitAttempt >= totalAttempts) {
					break;
				}

				if (
					executionMode === 'limit' &&
					(isRateLimited || isPostOnlyCross) &&
					this.#ctx.getAccounts()
				) {
					try {
						const book = await this.#ctx.getService().getOrderBookTop(this.#ctx.getAccounts());
						const nextPrice = isPostOnlyCross
							? input.isBid
								? round(book.bestBid, 6)
								: round(book.bestAsk, 6)
							: input.isBid
								? makerBidPrice(book.bestBid, book.bestAsk, book.tickSize)
								: makerAskPrice(book.bestBid, book.bestAsk, book.tickSize);
						if (nextPrice !== currentPrice) {
							currentPrice = nextPrice;
							currentNotionalUsd = round(input.quantity * currentPrice, 4);
							record.price = currentPrice;
							record.notionalUsd = currentNotionalUsd;
							await this.#ctx.persistCurrentOrders();
							await this.#ctx.appendLog(
								'info',
								`Repricing ${input.side.toLowerCase()} ${input.phase.toLowerCase()} maker order before retry.`,
								{
									account: input.account.label,
									accountKey: input.account.key,
									side: input.side,
									phase: input.phase,
									cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
									price: currentPrice
								}
							);
						}
					} catch {}
				}

				await this.#ctx.sleepInterruptible(retryDelayMs(message, submitAttempt));
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`${input.side} ${input.phase} maker order failed`);
	}

	async reconcileSubmittedOrderId(
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
		const known = new Set(knownOpenOrderIds);
		const service = this.#ctx.getService();

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const fromDigest = await service
				.getOrderIdFromTransaction(txDigest, clientOrderIdValue)
				.catch(() => undefined);
			if (fromDigest) {
				await this.#ctx.appendLog(
					'info',
					`${meta.side} ${meta.phase.toLowerCase()} order id reconciled from tx digest.`,
					{
						account: account.label,
						accountKey: account.key,
						side: meta.side,
						phase: meta.phase,
						cycleNumber: meta.cycleNumber,
						txDigest,
						orderId: fromDigest
					}
				);
				return fromDigest;
			}

			const openOrderIds = await service.getAccountOpenOrders(account).catch(() => []);
			const newOrderIds = openOrderIds.filter((orderId) => !known.has(orderId));
			if (newOrderIds.length > 0) {
				const inferredOrderId = [...newOrderIds].sort((a, b) =>
					BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0
				)[0];
				await this.#ctx.appendLog(
					'info',
					`${meta.side} ${meta.phase.toLowerCase()} order id reconciled from open orders.`,
					{
						account: account.label,
						accountKey: account.key,
						side: meta.side,
						phase: meta.phase,
						cycleNumber: meta.cycleNumber,
						txDigest,
						orderId: inferredOrderId
					}
				);
				return inferredOrderId;
			}

			if (attempt < 4) {
				await this.#ctx.sleepInterruptible(400 * attempt);
			}
		}

		return undefined;
	}

	async waitForFullFill(
		orderIndex: number,
		targetQuantity: number
	): Promise<{ price: number; paidFees: number; quantity: number; txDigest?: string }> {
		const config = this.#ctx.getConfig();
		const service = this.#ctx.getService();
		const accounts = this.#ctx.getAccounts();
		const epsilon = Math.max(1e-9, targetQuantity * 0.00001);
		let orderRecord = this.#ctx.getCurrentCycleOrders()[orderIndex];
		let remaining = targetQuantity;
		let latestPrice = orderRecord.price;
		let totalPaidFees = 0;
		const currentPaidFees = () => round(orderRecord.paidFeesQuote ?? totalPaidFees, 6);

		if (orderRecord.status === 'filled') {
			return {
				price: orderRecord.filledPrice ?? latestPrice,
				paidFees: currentPaidFees(),
				quantity: round(orderRecord.filledQuantity ?? targetQuantity, 9),
				txDigest: orderRecord.txDigest
			};
		}

		while (remaining > epsilon) {
			this.#ctx.throwIfStopping();

			const account = accounts[orderRecord.account];
			const orderId = orderRecord.orderId;
			if (!orderId) {
				throw new Error('Cannot wait for fill without an order id');
			}
			const markFilled = async () => {
				const fillPrice = round(orderRecord.price, 6);
				const orderFilledQuantity = round(orderRecord.quantity, 9);
				orderRecord.status = 'filled';
				orderRecord.filledPrice = fillPrice;
				orderRecord.filledQuantity = orderFilledQuantity;
				orderRecord.filledAt = nowIso();
				await this.#ctx.persistCurrentOrders();
				await this.#ctx.appendLog(
					'info',
					`${orderRecord.side} ${orderRecord.phase.toLowerCase()} order filled.`,
					{
						account: account.label,
						accountKey: orderRecord.account,
						side: orderRecord.side,
						phase: orderRecord.phase,
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
						orderId,
						quantity: orderFilledQuantity,
						fillPrice,
						paidFeesQuote: round(orderRecord.paidFeesQuote ?? 0, 6),
						txDigest: orderRecord.txDigest
					}
				);
			};

			const deadline = Date.now() + config.maker_reprice_seconds * 1000;
			let filled = false;

			while (Date.now() < deadline) {
				this.#ctx.throwIfStopping();
				const orderInfo = await this.#ctx.withRetry(
					'poll order state',
					() => service.getOrder(account, orderId),
					3,
					{
						account: account.label,
						side: orderRecord.side,
						phase: orderRecord.phase,
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber
					}
				);
				if (!orderInfo || Math.max(orderInfo.quantity - orderInfo.filledQuantity, 0) <= epsilon) {
					await markFilled();
					filled = true;
					break;
				}
				await this.#ctx.sleepInterruptible(config.order_poll_interval_ms);
			}

			if (filled) {
				return {
					price: latestPrice,
					paidFees: currentPaidFees(),
					quantity: round(targetQuantity, 9),
					txDigest: orderRecord.txDigest
				};
			}

			const orderInfo = await this.#ctx.withRetry(
				'inspect partial order state',
				() => service.getOrder(account, orderId),
				3,
				{
					account: account.label,
					side: orderRecord.side,
					phase: orderRecord.phase,
					cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber
				}
			);
			const remainingQuantity = orderInfo
				? Math.max(orderInfo.quantity - orderInfo.filledQuantity, 0)
				: 0;

			if (remainingQuantity <= epsilon) {
				await markFilled();
				return {
					price: latestPrice,
					paidFees: currentPaidFees(),
					quantity: round(targetQuantity, 9),
					txDigest: orderRecord.txDigest
				};
			}

			await this.#ctx.appendLog('info', 'Repricing partially filled maker order.', {
				account: account.label,
				side: orderRecord.side,
				phase: orderRecord.phase,
				cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
				orderId,
				remainingQuantity
			});

			await this.#ctx.withRetry(
				'cancel stale maker order',
				() => service.cancelAllOrders(account),
				3,
				{
					account: account.label,
					side: orderRecord.side,
					phase: orderRecord.phase,
					cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber
				}
			);
			const withdrawSettledResult = await this.#ctx.withRetry(
				'withdraw settled amounts after cancel',
				() => service.withdrawSettled(account),
				3,
				{
					account: account.label,
					side: orderRecord.side,
					phase: orderRecord.phase,
					cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber
				}
			);
			this.#recordCurrentCycleAuxiliaryGas(
				withdrawSettledResult?.gasUsedSui,
				this.#ctx.getSnapshot().price.price || latestPrice
			);
			const partialFillQuantity = orderInfo?.filledQuantity ?? 0;
			if (partialFillQuantity > epsilon) {
				orderRecord.filledQuantity = round(partialFillQuantity, 9);
				orderRecord.filledPrice = round(orderRecord.price, 6);
				orderRecord.filledAt = nowIso();
			}
			orderRecord.status = 'cancelled';
			await this.#ctx.persistCurrentOrders();

			await this.#ctx.randomDelay();
			const book = await this.#ctx.withRetry('reload orderbook for reprice', () =>
				service.getOrderBookTop(accounts)
			);
			const reprice =
				orderRecord.phase === 'OPEN'
					? orderRecord.isBid
						? round(book.bestBid, 6)
						: round(book.bestAsk, 6)
					: orderRecord.isBid
						? makerBidPrice(book.bestBid, book.bestAsk, book.tickSize)
						: makerAskPrice(book.bestBid, book.bestAsk, book.tickSize);
			let residualQuantity = remainingQuantity;
			if (orderRecord.phase === 'CLOSE') {
				const { closeQuantity } = await this.reloadCloseResidualState(
					account,
					this.#ctx.getSnapshot().activeCycle?.cycleNumber ?? 0,
					orderRecord.side
				);
				residualQuantity = closeQuantity;
			} else {
				const { residualQuantity: openResidualQuantity } = await this.reloadOpenResidualState(
					account,
					this.#ctx.getSnapshot().activeCycle?.cycleNumber ?? 0,
					orderRecord.side,
					targetQuantity,
					reprice
				);
				residualQuantity = openResidualQuantity;
			}
			if (residualQuantity <= epsilon) {
				return {
					price: latestPrice,
					paidFees: currentPaidFees(),
					quantity: round(targetQuantity - residualQuantity, 9)
				};
			}

			try {
				remaining = normalizeQuantity(residualQuantity, book.lotSize, book.minSize);
			} catch (error) {
				if (
					orderRecord.phase === 'CLOSE' &&
					error instanceof Error &&
					error.message === 'Configured notional is smaller than pool minimum size'
				) {
					await this.#ctx.appendLog(
						'info',
						`${orderRecord.side} close residual is below pool minimum size; handing off remainder to cleanup.`,
						{
							account: account.label,
							side: orderRecord.side,
							phase: orderRecord.phase,
							cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
							residualQuantity: round(residualQuantity, 9)
						}
					);
					return {
						price: latestPrice,
						paidFees: currentPaidFees(),
						quantity: round(targetQuantity - residualQuantity, 9)
					};
				}
				throw error;
			}
			latestPrice = reprice;
			if (orderRecord.phase === 'OPEN') {
				await this.#ctx.appendLog(
					'info',
					`Using boundary price for ${orderRecord.side.toLowerCase()} open residual retry after partial fill.`,
					{
						account: account.label,
						accountKey: account.key,
						side: orderRecord.side,
						phase: orderRecord.phase,
						cycleNumber: this.#ctx.getSnapshot().activeCycle?.cycleNumber,
						price: reprice
					}
				);
			}

			const replacement = await this.submitMakerOrder({
				account,
				side: orderRecord.side,
				phase: orderRecord.phase,
				isBid: orderRecord.isBid,
				price: reprice,
				quantity: remaining,
				notionalUsd: round(remaining * reprice, 4)
			});

			totalPaidFees = currentPaidFees();
			orderIndex = replacement.orderIndex;
			orderRecord = this.#ctx.getCurrentCycleOrders()[orderIndex];
		}

		return { price: latestPrice, paidFees: currentPaidFees(), quantity: round(targetQuantity, 9) };
	}

	async #markAutoTopupQueued(
		account: ManagedAccount,
		plan: AutoTopupPlan,
		cycleNumber: number | null
	): Promise<void> {
		await this.#ctx.appendLog('info', `Auto top-up swap planned for ${account.label}.`, {
			account: account.label,
			accountKey: account.key,
			phase: 'OPEN',
			cycleNumber,
			reason: plan.reason,
			[plan.coinOut === 'USDC' ? 'requiredUsdc' : 'requiredSui']: plan.requiredAmount,
			[plan.coinOut === 'USDC' ? 'currentUsdc' : 'currentSui']: plan.currentAmount,
			[plan.coinIn === 'SUI' ? 'estimatedSuiIn' : 'estimatedUsdcIn']: plan.amountIn
		});
		this.#ctx.setAutoTopupSnapshot({
			status: 'queued',
			account: plan.account,
			label: account.label,
			reason: plan.reason,
			cycleNumber,
			coinIn: plan.coinIn,
			coinOut: plan.coinOut,
			requiredAmount: plan.requiredAmount,
			currentAmount: plan.currentAmount,
			error: undefined
		});
	}

	async #markAutoTopupCompleted(
		account: ManagedAccount,
		plan: AutoTopupPlan,
		cycleNumber: number | null,
		result: AggregatorSwapResult
	): Promise<void> {
		await this.#ctx.appendLog('info', `Auto top-up swap completed for ${account.label}.`, {
			account: account.label,
			accountKey: account.key,
			phase: 'OPEN',
			cycleNumber,
			provider: result.provider,
			txDigest: result.txDigest,
			amountIn: result.amountIn,
			amountOut: result.amountOut,
			quoteSummary: result.quoteSummary,
			ptbShape: result.ptbShape
		});
		this.#ctx.setAutoTopupSnapshot({
			status: 'completed',
			account: plan.account,
			label: account.label,
			reason: plan.reason,
			cycleNumber,
			coinIn: plan.coinIn,
			coinOut: plan.coinOut,
			amountIn: result.amountIn,
			amountOut: result.amountOut,
			requiredAmount: plan.requiredAmount,
			currentAmount: plan.currentAmount,
			provider: String(result.provider),
			txDigest: result.txDigest,
			error: undefined
		});
	}

	async #markAutoTopupFailed(
		account: ManagedAccount,
		plan: AutoTopupPlan,
		cycleNumber: number | null,
		error: unknown
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const debugMeta = extractErrorDebugMeta(error);
		await this.#ctx.appendLog(
			'error',
			`Auto top-up swap failed for ${account.label} before order submission.`,
			{
				account: account.label,
				accountKey: account.key,
				phase: 'OPEN',
				cycleNumber,
				reason: plan.reason,
				error: message,
				debugMeta
			}
		);
		this.#ctx.setAutoTopupSnapshot({
			status: 'failed',
			account: plan.account,
			label: account.label,
			reason: plan.reason,
			cycleNumber,
			coinIn: plan.coinIn,
			coinOut: plan.coinOut,
			requiredAmount: plan.requiredAmount,
			currentAmount: plan.currentAmount,
			error: message
		});
	}

	async #executeAutoTopupSwap(input: {
		account: ManagedAccount;
		plan: AutoTopupPlan;
		accounts: Record<BotAccountKey, ManagedAccount>;
		referencePrice: number;
		cycleNumber: number | null;
	}): Promise<{ walletDepositBase?: number; walletDepositQuote?: number }> {
		const { account, plan, accounts, referencePrice, cycleNumber } = input;
		const service = this.#ctx.getService();
		const config = this.#ctx.getConfig();
		try {
			const result = await this.#ctx.withRetry(
				'execute auto top-up swap',
				() =>
					service.swapExactInWithAggregator({
						account,
						coinTypeIn: plan.coinTypeIn,
						coinTypeOut: plan.coinTypeOut,
						amountIn: plan.amountIn,
						useGasCoin: plan.coinIn === 'SUI'
					}),
				3,
				{
					account: account.label,
					phase: 'OPEN',
					cycleNumber,
					reason: plan.reason
				}
			);
			let walletDepositBase: number | undefined;
			let walletDepositQuote: number | undefined;
			try {
				const balances = await this.#ctx.withRetry(
					'refresh wallet balances after auto top-up',
					() => service.getWalletBalances(accounts, referencePrice),
					3,
					{
						account: account.label,
						phase: 'OPEN',
						cycleNumber
					}
				);
				this.#ctx.updateBalancesAndPreflight(balances, referencePrice);
				walletDepositBase =
					plan.coinOut === 'SUI'
						? round(
								Math.min(
									Math.max(balances[plan.account].sui - config.min_gas_reserve_sui, 0),
									plan.walletDepositAmount
								),
								9
							)
						: undefined;
				walletDepositQuote =
					plan.coinOut === 'USDC'
						? round(Math.min(balances[plan.account].usdc, plan.walletDepositAmount), 6)
						: undefined;
			} catch (balanceError) {
				const fallbackWalletAmount = plan.currentAmount + result.amountOut;
				const message = balanceError instanceof Error ? balanceError.message : String(balanceError);
				await this.#ctx.appendLog(
					'warn',
					`Unable to refresh wallet balances after auto top-up for ${account.label}; using estimated wallet funding.`,
					{
						account: account.label,
						phase: 'OPEN',
						cycleNumber,
						error: message,
						estimatedWalletAmount: fallbackWalletAmount
					}
				);
				walletDepositBase =
					plan.coinOut === 'SUI'
						? round(Math.min(fallbackWalletAmount, plan.walletDepositAmount), 9)
						: undefined;
				walletDepositQuote =
					plan.coinOut === 'USDC'
						? round(Math.min(fallbackWalletAmount, plan.walletDepositAmount), 6)
						: undefined;
			}
			await this.#markAutoTopupCompleted(account, plan, cycleNumber, result);
			this.#recordCurrentCycleAuxiliaryGas(result.gasUsedSui, referencePrice);

			return {
				walletDepositBase,
				walletDepositQuote
			};
		} catch (error) {
			await this.#markAutoTopupFailed(account, plan, cycleNumber, error);
			throw error;
		}
	}
}
