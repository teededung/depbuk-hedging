/**
 * Order submission and swap execution.
 * Covers limit orders, market orders, close PTBs, reduce-only orders, and aggregator swaps.
 */

import { coinWithBalance, Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { OrderType, SelfMatchingOptions } from '@mysten/deepbook-v3';

import type { DeepBookInternalContext } from './deepbook-context.js';
import type { ManagedAccount, PlacedOrderResult, AggregatorSwapResult } from './deepbook.js';
import {
	round,
	toAtomicUnits,
	floorToAtomicUnits,
	buildAskMarketBorrowBaseCandidates,
	buildLongCloseMarketRepayPlan,
	buildShortCloseMarketRepayPlan,
	computeBidQuoteBudget,
	extractExecutionSummaryFromEvents
} from './deepbook-shared.js';
import {
	extractOrderId,
	extractPaidFeesSummary,
	extractGasUsedSui,
	getMarginManagerState
} from './deepbook-margin-state.js';
import {
	getOrderBookTop,
	estimateMarketSellQuantityForQuoteTarget,
	estimateMarketBuyQuantityForBaseTarget,
	getPoolTradeParams
} from './deepbook-market-data.js';

class AggregatorExecutionError extends Error {
	readonly debugMeta: Record<string, unknown>;
	readonly causeError: unknown;

	constructor(message: string, debugMeta: Record<string, unknown>, causeError?: unknown) {
		super(message);
		this.name = 'AggregatorExecutionError';
		this.debugMeta = debugMeta;
		this.causeError = causeError;
	}
}

class OrderExecutionError extends Error {
	readonly debugMeta: Record<string, unknown>;
	readonly causeError: unknown;

	constructor(message: string, debugMeta: Record<string, unknown>, causeError?: unknown) {
		super(message);
		this.name = 'OrderExecutionError';
		this.debugMeta = debugMeta;
		this.causeError = causeError;
	}
}

function paidFeesFromEvents(ctx: DeepBookInternalContext, events: any[] | undefined) {
	return extractPaidFeesSummary(events, ctx.baseCoin.scalar, ctx.quoteCoin.scalar);
}

function isSettleDryRunAbortMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes('dry run failed') &&
		normalized.includes('moveabort') &&
		(normalized.includes('identifier("settle")') ||
			normalized.includes('function_name: some("settle")') ||
			normalized.includes('::settle'))
	);
}

export async function swapExactInWithAggregator(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		coinTypeIn: string;
		coinTypeOut: string;
		amountIn: number;
		useGasCoin?: boolean;
	}
	): Promise<AggregatorSwapResult> {
	const amountInAtomic = toAtomicUnits(input.amountIn, ctx.coinScalar(input.coinTypeIn));
	const { entry: aggregatorEntry, quotes } = await ctx.quoteWithAggregator({
		amountIn: amountInAtomic.toString(),
		coinTypeIn: input.coinTypeIn,
		coinTypeOut: input.coinTypeOut,
		signer: input.account.address
	});
	const metaAg = ctx.metaAgForEntry(aggregatorEntry);
	const bestQuote = ctx.selectBestAggregatorQuote(quotes);
	const useGasCoinDefault = input.useGasCoin ?? input.coinTypeIn === ctx.coins.SUI.type;
	const quoteOutput = (quote: (typeof quotes)[number]) =>
		Number(quote.simulatedAmountOut ?? quote.amountOut);
	const quoteIdentity = (quote: (typeof quotes)[number]) =>
		typeof quote.id === 'string' && quote.id.length > 0
			? `id:${quote.id}`
			: `${quote.provider}:${quote.amountIn}:${quote.amountOut}:${quote.coinTypeIn}:${quote.coinTypeOut}`;
	const seenQuoteKeys = new Set<string>();
	const orderedQuotes = [bestQuote, ...quotes]
		.sort((a, b) => quoteOutput(b) - quoteOutput(a))
		.filter((quote) => {
			const key = quoteIdentity(quote);
			if (seenQuoteKeys.has(key)) {
				return false;
			}
			seenQuoteKeys.add(key);
			return true;
		});
	const runSwap = async (
		quote: (typeof quotes)[number],
		useGasCoin: boolean,
		quoteSummary: Record<string, unknown>
	): Promise<AggregatorSwapResult> => {
		const tx = new Transaction();
		const coinOut = await metaAg.swap({
			quote,
			signer: input.account.address,
			tx,
			coinIn: coinWithBalance({
				type: input.coinTypeIn,
				balance: BigInt(quote.amountIn),
				useGasCoin
			})
		});
		tx.transferObjects([coinOut], input.account.address);

		const response = await ctx.signAndExecute(input.account, tx, {
			options: { showEffects: true, showEvents: true, showBalanceChanges: true }
		});

		return {
			provider: quote.provider,
			txDigest: response.digest,
			gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar),
			amountIn: ctx.normalizeCoinAmount(input.coinTypeIn, quote.amountIn),
			amountOut: ctx.normalizeCoinAmount(
				input.coinTypeOut,
				quote.simulatedAmountOut ?? quote.amountOut
			),
			coinTypeIn: input.coinTypeIn,
			coinTypeOut: input.coinTypeOut,
			quoteSummary
		};
	};

	const attemptedRoutes: Array<Record<string, unknown>> = [];
	let lastError: unknown;
	let lastQuoteSummary: Record<string, unknown> | null = null;
	let settleAbortSeen = false;
	let gasFallbackTried = false;

	for (const quote of orderedQuotes) {
		const quoteSummary = {
			...ctx.summarizeMetaQuote(quote),
			rpcUrl: aggregatorEntry.url
		};
		let shouldTryNonGasFallback = false;
		const quoteModes = useGasCoinDefault ? [true, false] : [false];
		for (const mode of quoteModes) {
			if (useGasCoinDefault && mode === false && !shouldTryNonGasFallback) {
				continue;
			}
			try {
				return await runSwap(quote, mode, quoteSummary);
			} catch (error) {
				lastError = error;
				lastQuoteSummary = quoteSummary;
				const message = error instanceof Error ? error.message : String(error);
				const isSettleAbort = isSettleDryRunAbortMessage(message);
				if (isSettleAbort) {
					settleAbortSeen = true;
				}
				attemptedRoutes.push({
					provider: quote.provider,
					quoteId: quote.id,
					useGasCoin: mode,
					error: message,
					settleAbort: isSettleAbort
				});
				if (!isSettleAbort) {
					throw new AggregatorExecutionError(
						message,
						{
							quoteSummary,
							coinTypeIn: input.coinTypeIn,
							coinTypeOut: input.coinTypeOut,
							requestedAmountIn: input.amountIn,
							fallbackRetry: {
								attempted: gasFallbackTried,
								fromUseGasCoin: useGasCoinDefault
							},
							attemptedRoutes
						},
						error
					);
				}
				// Some aggregator routes can fail dry-run settle when SUI input is sourced from gas coin.
				// Retry the same route once with a regular SUI coin before switching to alternate quotes.
				if (useGasCoinDefault && mode === true) {
					shouldTryNonGasFallback = true;
					gasFallbackTried = true;
					continue;
				}
				break;
			}
		}
	}

	const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
	throw new AggregatorExecutionError(
		finalMessage,
		{
			quoteSummary: lastQuoteSummary ?? {
				...ctx.summarizeMetaQuote(bestQuote),
				rpcUrl: aggregatorEntry.url
			},
			coinTypeIn: input.coinTypeIn,
			coinTypeOut: input.coinTypeOut,
			requestedAmountIn: input.amountIn,
			fallbackRetry: {
				attempted: gasFallbackTried,
				reason: settleAbortSeen ? 'settle-dry-run-abort' : undefined,
				fromUseGasCoin: useGasCoinDefault
			},
			attemptedRoutes
		},
		lastError
	);
}

export async function transferUsdcBetweenAccounts(
	ctx: DeepBookInternalContext,
	input: {
		from: ManagedAccount;
		to: ManagedAccount;
		amount: number;
	}
): Promise<{ txDigest: string; amount: number; coinType: string }> {
	const amountAtomic = floorToAtomicUnits(input.amount, ctx.quoteCoin.scalar);
	if (amountAtomic <= 0n) {
		throw new Error('USDC transfer amount must be greater than zero');
	}

	const coinObjectIds: string[] = [];
	let selectedAtomic = 0n;
	let cursor: string | null | undefined = undefined;
	while (selectedAtomic < amountAtomic) {
		const page = await ctx.withReadRpc(`get USDC coins for ${input.from.label}`, (client) =>
			client.getCoins({
				owner: input.from.address,
				coinType: ctx.quoteCoin.type,
				cursor,
				limit: 50
			})
		);
		const coins = page.data ?? [];
		for (const coin of coins) {
			coinObjectIds.push(coin.coinObjectId);
			selectedAtomic += BigInt(coin.balance ?? 0);
			if (selectedAtomic >= amountAtomic) {
				break;
			}
		}

		if (selectedAtomic >= amountAtomic) {
			break;
		}
		if (!page.hasNextPage || !page.nextCursor) {
			break;
		}
		cursor = page.nextCursor;
	}

	if (coinObjectIds.length === 0 || selectedAtomic < amountAtomic) {
		const requestedAmount = ctx.normalizeCoinAmount(ctx.quoteCoin.type, amountAtomic);
		const availableAmount = ctx.normalizeCoinAmount(ctx.quoteCoin.type, selectedAtomic);
		throw new Error(
			`Not enough USDC in ${input.from.label} wallet for transfer. Requested ${requestedAmount.toFixed(6)} USDC, available ${availableAmount.toFixed(6)} USDC.`
		);
	}

	const tx = new Transaction();
	tx.setSender(input.from.address);
	const primaryCoin = tx.object(coinObjectIds[0]!);
	if (coinObjectIds.length > 1) {
		tx.mergeCoins(
			primaryCoin,
			coinObjectIds.slice(1).map((coinObjectId) => tx.object(coinObjectId))
		);
	}
	const [transferCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountAtomic)]);
	tx.transferObjects([transferCoin], tx.pure.address(input.to.address));

	const response = await ctx.signAndExecute(input.from, tx, {
		options: { showEffects: true, showEvents: true, showBalanceChanges: true }
	});

	return {
		txDigest: response.digest,
		amount: round(ctx.normalizeCoinAmount(ctx.quoteCoin.type, amountAtomic), 6),
		coinType: ctx.quoteCoin.type
	};
}

export async function transferSuiBetweenAccounts(
	ctx: DeepBookInternalContext,
	input: {
		from: ManagedAccount;
		to: ManagedAccount;
		amount: number;
	}
): Promise<{ txDigest: string; amount: number; coinType: string }> {
	const amountAtomic = floorToAtomicUnits(input.amount, ctx.baseCoin.scalar);
	if (amountAtomic <= 0n) {
		throw new Error('SUI transfer amount must be greater than zero');
	}

	let totalAtomic = 0n;
	let cursor: string | null | undefined = undefined;
	while (true) {
		const page = await ctx.withReadRpc(`get SUI coins for ${input.from.label}`, (client) =>
			client.getCoins({
				owner: input.from.address,
				coinType: ctx.baseCoin.type,
				cursor,
				limit: 50
			})
		);
		const coins = page.data ?? [];
		for (const coin of coins) {
			totalAtomic += BigInt(coin.balance ?? 0);
		}

		if (!page.hasNextPage || !page.nextCursor) {
			break;
		}
		cursor = page.nextCursor;
	}

	const gasReserveAtomic = floorToAtomicUnits(
		Math.max(ctx.config.min_gas_reserve_sui, 0),
		ctx.baseCoin.scalar
	);
	const transferableAtomic = totalAtomic > gasReserveAtomic ? totalAtomic - gasReserveAtomic : 0n;
	if (totalAtomic <= 0n || transferableAtomic < amountAtomic) {
		const requestedAmount = ctx.normalizeCoinAmount(ctx.baseCoin.type, amountAtomic);
		const availableAmount = ctx.normalizeCoinAmount(ctx.baseCoin.type, transferableAtomic);
		const reserveAmount = ctx.normalizeCoinAmount(ctx.baseCoin.type, gasReserveAtomic);
		throw new Error(
			`Not enough SUI in ${input.from.label} wallet for transfer after gas reserve. Requested ${requestedAmount.toFixed(6)} SUI, available ${availableAmount.toFixed(6)} SUI after reserving ${reserveAmount.toFixed(6)} SUI.`
		);
	}

	const tx = new Transaction();
	tx.setSender(input.from.address);
	// Split from gas coin so a wallet with a single SUI coin can still pay gas and transfer.
	const [transferCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountAtomic)]);
	tx.transferObjects([transferCoin], tx.pure.address(input.to.address));

	const response = await ctx.signAndExecute(input.from, tx, {
		options: { showEffects: true, showEvents: true, showBalanceChanges: true }
	});

	return {
		txDigest: response.digest,
		amount: round(ctx.normalizeCoinAmount(ctx.baseCoin.type, amountAtomic), 9),
		coinType: ctx.baseCoin.type
	};
}

export async function placeMarginLimitOrder(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		price: number;
		quantity: number;
		isBid: boolean;
		setMarginManagerReferral?: boolean;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	const { marginManager, poolProxy } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	if (input.walletDepositBase && input.walletDepositBase > 0) {
		marginManager.depositBase({ managerKey: account.key, amount: input.walletDepositBase })(tx);
	} else if (input.depositBase && input.depositBase > 0) {
		marginManager.depositBase({ managerKey: account.key, amount: input.depositBase })(tx);
	}
	if (input.walletDepositQuote && input.walletDepositQuote > 0) {
		marginManager.depositQuote({ managerKey: account.key, amount: input.walletDepositQuote })(tx);
	} else if (input.depositQuote && input.depositQuote > 0) {
		marginManager.depositQuote({ managerKey: account.key, amount: input.depositQuote })(tx);
	}
	if (input.borrowBase && input.borrowBase > 0) {
		marginManager.borrowBase(account.key, input.borrowBase)(tx);
	}
	if (input.borrowQuote && input.borrowQuote > 0) {
		marginManager.borrowQuote(account.key, input.borrowQuote)(tx);
	}
	if (input.setMarginManagerReferral && ctx.marginManagerReferralId) {
		marginManager.setMarginManagerReferral(account.key, ctx.marginManagerReferralId)(tx);
	}

	poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);
	poolProxy.placeLimitOrder({
		poolKey: ctx.config.pool_key,
		marginManagerKey: account.key,
		clientOrderId: input.clientOrderId,
		price: input.price,
		quantity: input.quantity,
		isBid: input.isBid,
		orderType: OrderType.POST_ONLY,
		selfMatchingOption: SelfMatchingOptions.CANCEL_TAKER,
		payWithDeep: false
	})(tx);

	const response = await ctx.signAndExecute(account, tx, {
		options: {
			showEffects: true,
			showEvents: true,
			showObjectChanges: true,
			showBalanceChanges: true
		}
	});
	const paidFees = paidFeesFromEvents(ctx, response.events);

	return {
		txDigest: response.digest,
		clientOrderId: input.clientOrderId,
		orderId: extractOrderId(response.events, input.clientOrderId),
		paidFeesQuote: paidFees.quoteEquivalent,
		paidFeesAmount: paidFees.amount,
		paidFeesAsset: paidFees.asset,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar)
	};
}

export async function placeMarginLimitOrderDeeptradeStyle(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		price: number;
		quantity: number;
		isBid: boolean;
		setMarginManagerReferral?: boolean;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	const { marginManager, poolProxy } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	await ctx.appendLatestPythUpdates(tx);

	if (input.walletDepositBase && input.walletDepositBase > 0) {
		marginManager.depositBase({ managerKey: account.key, amount: input.walletDepositBase })(tx);
	} else if (input.depositBase && input.depositBase > 0) {
		marginManager.depositBase({ managerKey: account.key, amount: input.depositBase })(tx);
	}
	if (input.walletDepositQuote && input.walletDepositQuote > 0) {
		marginManager.depositQuote({ managerKey: account.key, amount: input.walletDepositQuote })(tx);
	} else if (input.depositQuote && input.depositQuote > 0) {
		marginManager.depositQuote({ managerKey: account.key, amount: input.depositQuote })(tx);
	}
	if (input.borrowBase && input.borrowBase > 0) {
		marginManager.borrowBase(account.key, input.borrowBase)(tx);
	}
	if (input.borrowQuote && input.borrowQuote > 0) {
		marginManager.borrowQuote(account.key, input.borrowQuote)(tx);
	}
	if (input.setMarginManagerReferral && ctx.marginManagerReferralId) {
		marginManager.setMarginManagerReferral(account.key, ctx.marginManagerReferralId)(tx);
	}

	poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);
	poolProxy.placeLimitOrder({
		poolKey: ctx.config.pool_key,
		marginManagerKey: account.key,
		clientOrderId: input.clientOrderId,
		price: input.price,
		quantity: input.quantity,
		isBid: input.isBid,
		orderType: OrderType.POST_ONLY,
		selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
		payWithDeep: false
	})(tx);

	const response = await ctx.signAndExecute(account, tx, {
		options: {
			showEffects: true,
			showEvents: true,
			showObjectChanges: true,
			showBalanceChanges: true
		}
	});
	const paidFees = paidFeesFromEvents(ctx, response.events);

	return {
		txDigest: response.digest,
		clientOrderId: input.clientOrderId,
		orderId: extractOrderId(response.events, input.clientOrderId),
		paidFeesQuote: paidFees.quoteEquivalent,
		paidFeesAmount: paidFees.amount,
		paidFeesAsset: paidFees.asset,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar)
	};
}

export async function placeMarginMarketOrder(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		quantity: number;
		isBid: boolean;
		setMarginManagerReferral?: boolean;
		depositBase?: number;
		depositQuote?: number;
		walletDepositBase?: number;
		walletDepositQuote?: number;
		borrowBase?: number;
		borrowQuote?: number;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	const { takerFee: takerFeeRate } = await getPoolTradeParams(ctx).catch(() => ({
		takerFee: 0,
		makerFee: 0
	}));
	const currentBorrowBase = round(Math.max(input.borrowBase ?? 0, 0), 9);
	const currentWalletDepositBase = round(Math.max(input.walletDepositBase ?? 0, 0), 9);
	const currentBaseFunding = round(
		(input.depositBase ?? 0) + currentWalletDepositBase + currentBorrowBase,
		9
	);
	const shortAskBorrowCandidates =
		!input.isBid && currentBorrowBase > 0 && currentBaseFunding > 0
			? buildAskMarketBorrowBaseCandidates({
					quantity: input.quantity,
					currentBorrowBase,
					currentBaseFunding,
					takerFeeRate
				})
			: [currentBorrowBase];
	const availableWalletBaseHeadroom =
		!input.isBid && shortAskBorrowCandidates.length > 1
			? round(
					Math.max(
						(await getWalletBaseBalance(ctx, account).catch(() => 0)) -
							ctx.config.min_gas_reserve_sui -
							currentWalletDepositBase -
							(input.depositBase ?? 0),
						0
					),
					9
				)
			: 0;
	let lastError: unknown;

	for (const borrowBaseCandidate of shortAskBorrowCandidates) {
		try {
			const additionalBaseHeadroom = round(Math.max(borrowBaseCandidate - currentBorrowBase, 0), 9);
			const extraWalletDepositBase = round(
				Math.min(availableWalletBaseHeadroom, additionalBaseHeadroom),
				9
			);
			const effectiveWalletDepositBase = round(
				currentWalletDepositBase + extraWalletDepositBase,
				9
			);
			const effectiveBorrowBase = round(
				Math.max(borrowBaseCandidate - extraWalletDepositBase, 0),
				9
			);
			const { config, marginManager, poolProxy } = ctx.sdk({ [account.key]: account });
			const tx = new Transaction();
			tx.setSender(account.address);
			await ctx.appendLatestPythUpdates(tx);
			if (effectiveWalletDepositBase > 0) {
				marginManager.depositBase({
					managerKey: account.key,
					amount: effectiveWalletDepositBase
				})(tx);
			}
			if (input.depositBase && input.depositBase > 0) {
				marginManager.depositBase({ managerKey: account.key, amount: input.depositBase })(tx);
			}
			if (input.walletDepositQuote && input.walletDepositQuote > 0) {
				marginManager.depositQuote({ managerKey: account.key, amount: input.walletDepositQuote })(
					tx
				);
			} else if (input.depositQuote && input.depositQuote > 0) {
				marginManager.depositQuote({ managerKey: account.key, amount: input.depositQuote })(tx);
			}
			if (effectiveBorrowBase > 0) {
				marginManager.borrowBase(account.key, effectiveBorrowBase)(tx);
			}
			if (input.borrowQuote && input.borrowQuote > 0) {
				marginManager.borrowQuote(account.key, input.borrowQuote)(tx);
			}
			if (input.setMarginManagerReferral && ctx.marginManagerReferralId) {
				marginManager.setMarginManagerReferral(account.key, ctx.marginManagerReferralId)(tx);
			}
			poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);
			const directQuoteBudget = round(
				(input.depositQuote ?? 0) + (input.walletDepositQuote ?? 0) + (input.borrowQuote ?? 0),
				9
			);
			const shouldDeriveBidQuantityFromQuoteBudget =
				input.isBid &&
				directQuoteBudget > 0 &&
				(input.borrowQuote ?? 0) > 0 &&
				currentBorrowBase <= 0;
			const quoteBudget = shouldDeriveBidQuantityFromQuoteBudget
				? computeBidQuoteBudget({
						referencePrice: 0,
						depositBase: input.depositBase,
						walletDepositBase: input.walletDepositBase,
						depositQuote: input.depositQuote,
						walletDepositQuote: input.walletDepositQuote,
						borrowQuote: input.borrowQuote
					})
				: directQuoteBudget;
			const safeBidQuoteBudget = shouldDeriveBidQuantityFromQuoteBudget
				? round(
						Math.max(
							quoteBudget *
								(1 -
									Math.min(Math.max(takerFeeRate * 3, 0.001), 0.05)),
							0
						),
						9
					)
				: quoteBudget;
			let marketOrderQuantity: TransactionArgument = tx.pure.u64(
				Math.round(input.quantity * ctx.baseCoin.scalar)
			);
			if (shouldDeriveBidQuantityFromQuoteBudget && safeBidQuoteBudget > 0) {
				const pool = config.getPool(ctx.config.pool_key);
				const [derivedBaseQuantity] = tx.moveCall({
					target: `${ctx.packageIds.DEEPBOOK_PACKAGE_ID}::pool::get_base_quantity_out`,
					arguments: [
						tx.object(pool.address),
						tx.pure.u64(Math.round(safeBidQuoteBudget * ctx.quoteCoin.scalar)),
						tx.object.clock()
					],
					typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
				});
				marketOrderQuantity = derivedBaseQuantity;
			}
			const manager = config.getMarginManager(account.key);
			const pool = config.getPool(ctx.config.pool_key);
			tx.moveCall({
				target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::pool_proxy::place_market_order`,
				arguments: [
					tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
					tx.object(manager.address),
					tx.object(pool.address),
					tx.pure.u64(input.clientOrderId),
					tx.pure.u8(SelfMatchingOptions.CANCEL_TAKER),
					marketOrderQuantity,
					tx.pure.bool(input.isBid),
					tx.pure.bool(false),
					tx.object.clock()
				],
				typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
			});

			const response = await ctx.signAndExecute(account, tx, {
				options: { showEvents: true, showEffects: true, showBalanceChanges: true }
			});
			const executionSummary = extractExecutionSummaryFromEvents(
				response.events,
				input.clientOrderId,
				ctx.baseCoin.scalar,
				ctx.quoteCoin.scalar
			);
			const paidFees = paidFeesFromEvents(ctx, response.events);

			return {
				txDigest: response.digest,
				clientOrderId: input.clientOrderId,
				orderId: extractOrderId(response.events, input.clientOrderId),
				paidFeesQuote: paidFees.quoteEquivalent,
				paidFeesAmount: paidFees.amount,
				paidFeesAsset: paidFees.asset,
				gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar),
				filledQuantity: executionSummary?.filledQuantity,
				filledQuoteQuantity: executionSummary?.filledQuoteQuantity,
				averageFillPrice: executionSummary?.averageFillPrice
			};
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			const shouldRetryWithExtraBorrow =
				!input.isBid &&
				shortAskBorrowCandidates.length > 1 &&
				message.includes('withdraw_with_proof') &&
				borrowBaseCandidate !== shortAskBorrowCandidates[shortAskBorrowCandidates.length - 1];
			if (!shouldRetryWithExtraBorrow) {
				throw error;
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error('Market order submission failed');
}

async function getWalletBaseBalance(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<number> {
	const balance = await ctx.withReadRpc(`getBalance ${ctx.baseCoin.type}`, (client) =>
		client.getBalance({
			owner: account.address,
			coinType: ctx.baseCoin.type
		})
	);

	return round(Number(balance.totalBalance ?? 0) / ctx.baseCoin.scalar, 9);
}

export async function placeLongCloseMarketOrderAndRepayQuote(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		targetQuoteDebt: number;
		maxBaseQuantity: number;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	if (!account.marginManagerId) {
		throw new Error(`Missing margin manager id for ${account.label}`);
	}

	const state = await getMarginManagerState(ctx, account);
	const orderBook = await getOrderBookTop(ctx, { [account.key]: account });
	const cappedBaseQuantity = round(
		Math.min(Math.max(input.maxBaseQuantity, 0), Math.max(state.baseAsset, 0)),
		9
	);
	const estimatedSellQuantity =
		cappedBaseQuantity > 0
			? await estimateMarketSellQuantityForQuoteTarget(ctx, {
					targetQuote: Math.max(input.targetQuoteDebt - state.quoteAsset, 0),
					maxBaseQuantity: cappedBaseQuantity,
					lotSize: orderBook.lotSize,
					minSize: orderBook.minSize
				})
			: null;
	const plan = buildLongCloseMarketRepayPlan({
		targetQuoteDebt: input.targetQuoteDebt,
		quoteAsset: state.quoteAsset,
		maxBaseQuantity: cappedBaseQuantity,
		estimatedSellQuantity,
		lotSize: orderBook.lotSize
	});
	const { config, marginManager, marginTPSL, poolProxy } = ctx.sdk({ [account.key]: account });
	const baseMarginPool = ctx.marginPools[ctx.pool.baseCoin as string];
	const quoteMarginPool = ctx.marginPools[ctx.pool.quoteCoin as string];
	const tx = new Transaction();
	tx.setSender(account.address);
	await ctx.appendLatestPythUpdates(tx);
	marginTPSL.cancelAllConditionalOrders(account.key)(tx);
	poolProxy.withdrawSettledAmounts(account.key)(tx);
	poolProxy.cancelAllOrders(account.key)(tx);
	poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);

	if (plan.computedSellQuantity > 0) {
		const manager = config.getMarginManager(account.key);
		const pool = config.getPool(ctx.config.pool_key);
		tx.moveCall({
			target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::pool_proxy::place_market_order`,
			arguments: [
				tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
				tx.object(manager.address),
				tx.object(pool.address),
				tx.pure.u64(input.clientOrderId),
				tx.pure.u8(SelfMatchingOptions.CANCEL_TAKER),
				tx.pure.u64(Math.round(plan.computedSellQuantity * ctx.baseCoin.scalar)),
				tx.pure.bool(false),
				tx.pure.bool(false),
				tx.object.clock()
			],
			typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
		});
	}

	if (Math.max(input.targetQuoteDebt, 0) > 0) {
		tx.moveCall({
			target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::repay_quote`,
			arguments: [
				tx.object(account.marginManagerId),
				tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
				tx.object(quoteMarginPool.address),
				tx.pure.option('u64', null),
				tx.object.clock()
			],
			typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
		});
	}

	const [baseAssetAmount, quoteAssetAmount] = marginManager.calculateAssets(
		ctx.config.pool_key,
		account.marginManagerId
	)(tx) as unknown as [TransactionArgument, TransactionArgument];
	const withdrawnBaseCoin = tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::withdraw`,
		arguments: [
			tx.object(account.marginManagerId),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.object(quoteMarginPool.address),
			tx.object(ctx.baseCoin.priceInfoObjectId!),
			tx.object(ctx.quoteCoin.priceInfoObjectId!),
			tx.object(ctx.pool.address),
			baseAssetAmount,
			tx.object.clock()
		],
		typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type, ctx.baseCoin.type]
	});
	const withdrawnQuoteCoin = tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::withdraw`,
		arguments: [
			tx.object(account.marginManagerId),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.object(quoteMarginPool.address),
			tx.object(ctx.baseCoin.priceInfoObjectId!),
			tx.object(ctx.quoteCoin.priceInfoObjectId!),
			tx.object(ctx.pool.address),
			quoteAssetAmount,
			tx.object.clock()
		],
		typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type, ctx.quoteCoin.type]
	});

	tx.transferObjects([withdrawnBaseCoin, withdrawnQuoteCoin], tx.pure.address(account.address));

	let response: any;
	try {
		response = await ctx.signAndExecute(account, tx, {
			options: { showEvents: true, showEffects: true, showBalanceChanges: true }
		});
	} catch (error) {
		throw new OrderExecutionError(
			error instanceof Error ? error.message : String(error),
			{
				account: account.label,
				accountKey: account.key,
				side: 'LONG',
				phase: 'CLOSE',
				repayMode: 'all_available',
				targetQuoteDebt: round(input.targetQuoteDebt, 6),
				netQuoteDebt: plan.netQuoteDebt,
				quoteAsset: round(state.quoteAsset, 6),
				maxBaseQuantity: cappedBaseQuantity,
				computedSellQuantity: plan.computedSellQuantity,
				estimatedQuoteOut: plan.estimatedQuoteOut
			},
			error
		);
	}
	const executionSummary = extractExecutionSummaryFromEvents(
		response.events,
		input.clientOrderId,
		ctx.baseCoin.scalar,
		ctx.quoteCoin.scalar
	);
	const paidFees = paidFeesFromEvents(ctx, response.events);

	return {
		txDigest: response.digest,
		clientOrderId: input.clientOrderId,
		orderId: extractOrderId(response.events, input.clientOrderId),
		paidFeesQuote: paidFees.quoteEquivalent,
		paidFeesAmount: paidFees.amount,
		paidFeesAsset: paidFees.asset,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar),
		filledQuantity: executionSummary?.filledQuantity,
		filledQuoteQuantity: executionSummary?.filledQuoteQuantity,
		averageFillPrice: executionSummary?.averageFillPrice,
		netQuoteDebt: plan.netQuoteDebt,
		computedSellQuantity: plan.computedSellQuantity
	};
}

/**
 * DeepTrade-aligned short close PTB.
 *
 * Sequence (matches ref tx HbTrVjt9xWGsbcP5CVDCbx25sg31x77KfijYo65n3HF9):
 *   1. Pyth prepend
 *   2. cancel_all_conditional_orders
 *   3. withdraw_settled_amounts
 *   4. cancel_all_orders
 *   5. get_base_quantity_out  (derive buy quantity from quote budget)
 *   6. update_current_price
 *   7. place_market_order     (market buy)
 *   8. repay_base             (single post-buy repay with None = repay all)
 *   9. calculate_assets
 *  10. withdraw base
 *  11. withdraw quote
 *  12. transfer outputs
 */
export async function placeShortCloseMarketOrderAndRepayBase(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		targetBaseDebt: number;
		maxQuoteQuantity: number;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	if (!account.marginManagerId) {
		throw new Error(`Missing margin manager id for ${account.label}`);
	}

	const state = await getMarginManagerState(ctx, account);
	const orderBook = await getOrderBookTop(ctx, { [account.key]: account });
	const cappedQuoteQuantity = round(
		Math.min(Math.max(input.maxQuoteQuantity, 0), Math.max(state.quoteAsset, 0)),
		6
	);

	const targetBaseDebt = round(Math.max(input.targetBaseDebt, 0), 9);
	const estimatedBuyQuantity =
		cappedQuoteQuantity > 0 && targetBaseDebt > 0
			? await estimateMarketBuyQuantityForBaseTarget(ctx, {
					targetBase: targetBaseDebt,
					maxQuoteQuantity: cappedQuoteQuantity,
					lotSize: orderBook.lotSize,
					minSize: orderBook.minSize
				})
			: null;
	const plan = buildShortCloseMarketRepayPlan({
		targetBaseDebt: input.targetBaseDebt,
		baseAsset: state.baseAsset,
		quoteAsset: state.quoteAsset,
		maxQuoteQuantity: cappedQuoteQuantity,
		estimatedBuyQuantity
	});

	const { config, marginManager, marginTPSL, poolProxy } = ctx.sdk({ [account.key]: account });
	const baseMarginPool = ctx.marginPools[ctx.pool.baseCoin as string];
	const quoteMarginPool = ctx.marginPools[ctx.pool.quoteCoin as string];
	const tx = new Transaction();
	tx.setSender(account.address);
	await ctx.appendLatestPythUpdates(tx);
	marginTPSL.cancelAllConditionalOrders(account.key)(tx);
	poolProxy.withdrawSettledAmounts(account.key)(tx);
	poolProxy.cancelAllOrders(account.key)(tx);

	const pool = config.getPool(ctx.config.pool_key);
	const manager = config.getMarginManager(account.key);

	if (plan.computedQuoteBudget > 0) {
		const [derivedBaseQuantity] = tx.moveCall({
			target: `${ctx.packageIds.DEEPBOOK_PACKAGE_ID}::pool::get_base_quantity_out`,
			arguments: [
				tx.object(pool.address),
				tx.pure.u64(Math.round(plan.computedQuoteBudget * ctx.quoteCoin.scalar)),
				tx.object.clock()
			],
			typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
		});

		poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);

		tx.moveCall({
			target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::pool_proxy::place_market_order`,
			arguments: [
				tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
				tx.object(manager.address),
				tx.object(pool.address),
				tx.pure.u64(input.clientOrderId),
				tx.pure.u8(SelfMatchingOptions.CANCEL_TAKER),
				derivedBaseQuantity,
				tx.pure.bool(true),
				tx.pure.bool(false),
				tx.object.clock()
			],
			typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
		});
	} else {
		poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);
	}

	// Post-buy repay_base(None) — let the protocol repay all available base against debt.
	tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::repay_base`,
		arguments: [
			tx.object(account.marginManagerId),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.pure.option('u64', null),
			tx.object.clock()
		],
		typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
	});

	const [baseAssetAmount, quoteAssetAmount] = marginManager.calculateAssets(
		ctx.config.pool_key,
		account.marginManagerId
	)(tx) as unknown as [TransactionArgument, TransactionArgument];
	const withdrawnBaseCoin = tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::withdraw`,
		arguments: [
			tx.object(account.marginManagerId),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.object(quoteMarginPool.address),
			tx.object(ctx.baseCoin.priceInfoObjectId!),
			tx.object(ctx.quoteCoin.priceInfoObjectId!),
			tx.object(ctx.pool.address),
			baseAssetAmount,
			tx.object.clock()
		],
		typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type, ctx.baseCoin.type]
	});
	const withdrawnQuoteCoin = tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::withdraw`,
		arguments: [
			tx.object(account.marginManagerId),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.object(quoteMarginPool.address),
			tx.object(ctx.baseCoin.priceInfoObjectId!),
			tx.object(ctx.quoteCoin.priceInfoObjectId!),
			tx.object(ctx.pool.address),
			quoteAssetAmount,
			tx.object.clock()
		],
		typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type, ctx.quoteCoin.type]
	});

	tx.transferObjects([withdrawnBaseCoin, withdrawnQuoteCoin], tx.pure.address(account.address));

	const response = await ctx.signAndExecute(account, tx, {
		options: { showEvents: true, showEffects: true, showBalanceChanges: true }
	});
	const executionSummary = extractExecutionSummaryFromEvents(
		response.events,
		input.clientOrderId,
		ctx.baseCoin.scalar,
		ctx.quoteCoin.scalar
	);
	const paidFees = paidFeesFromEvents(ctx, response.events);

	return {
		txDigest: response.digest,
		clientOrderId: input.clientOrderId,
		orderId: extractOrderId(response.events, input.clientOrderId),
		paidFeesQuote: paidFees.quoteEquivalent,
		paidFeesAmount: paidFees.amount,
		paidFeesAsset: paidFees.asset,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar),
		filledQuantity: executionSummary?.filledQuantity,
		filledQuoteQuantity: executionSummary?.filledQuoteQuantity,
		averageFillPrice: executionSummary?.averageFillPrice,
		netBaseDebt: plan.targetBaseDebt,
		computedQuoteBudget: plan.computedQuoteBudget,
		computedBuyQuantity: plan.computedBuyQuantity,
		preRepaidBaseQuantity: 0
	};
}

export async function placeReduceOnlyMarginMarketOrder(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		quantity: number;
		isBid: boolean;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	const { poolProxy } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);
	poolProxy.placeReduceOnlyMarketOrder({
		poolKey: ctx.config.pool_key,
		marginManagerKey: account.key,
		clientOrderId: input.clientOrderId,
		quantity: input.quantity,
		isBid: input.isBid,
		selfMatchingOption: SelfMatchingOptions.CANCEL_TAKER,
		payWithDeep: false
	})(tx);

	const response = await ctx.signAndExecute(account, tx, {
		options: { showEvents: true, showEffects: true, showBalanceChanges: true }
	});
	const paidFees = paidFeesFromEvents(ctx, response.events);

	return {
		txDigest: response.digest,
		clientOrderId: input.clientOrderId,
		orderId: extractOrderId(response.events, input.clientOrderId),
		paidFeesQuote: paidFees.quoteEquivalent,
		paidFeesAmount: paidFees.amount,
		paidFeesAsset: paidFees.asset,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar)
	};
}

export async function placeReduceOnlyMarginLimitOrder(
	ctx: DeepBookInternalContext,
	input: {
		account: ManagedAccount;
		clientOrderId: string;
		price: number;
		quantity: number;
		isBid: boolean;
	}
): Promise<PlacedOrderResult> {
	const { account } = input;
	const { poolProxy } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	poolProxy.updateCurrentPrice(ctx.config.pool_key)(tx);
	poolProxy.placeReduceOnlyLimitOrder({
		poolKey: ctx.config.pool_key,
		marginManagerKey: account.key,
		clientOrderId: input.clientOrderId,
		price: input.price,
		quantity: input.quantity,
		isBid: input.isBid,
		orderType: OrderType.NO_RESTRICTION,
		selfMatchingOption: SelfMatchingOptions.CANCEL_TAKER,
		payWithDeep: false
	})(tx);

	const response = await ctx.signAndExecute(account, tx, {
		options: { showEvents: true, showEffects: true, showBalanceChanges: true }
	});
	const paidFees = paidFeesFromEvents(ctx, response.events);

	return {
		txDigest: response.digest,
		clientOrderId: input.clientOrderId,
		orderId: extractOrderId(response.events, input.clientOrderId),
		paidFeesQuote: paidFees.quoteEquivalent,
		paidFeesAmount: paidFees.amount,
		paidFeesAsset: paidFees.asset,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar)
	};
}
