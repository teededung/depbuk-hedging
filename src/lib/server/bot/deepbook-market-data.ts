/**
 * Orderbook, live price, and market estimator operations.
 * All functions receive the internal context — no direct state ownership.
 */

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { FLOAT_SCALAR } from '@mysten/deepbook-v3';

import type { DeepBookInternalContext } from './deepbook-context.js';
import type { ManagedAccount, OrderBookTop, LivePriceQuote } from './deepbook.js';
import type { BotAccountKey } from './types.js';
import { round, marketBuyCoverageTargetBase } from './deepbook-shared.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function getOrderBookTopFromChain(
	ctx: DeepBookInternalContext,
	accounts: Partial<Record<BotAccountKey, ManagedAccount>>
): Promise<OrderBookTop> {
	const { deepbook } = ctx.sdk(accounts);
	const tx = new Transaction();
	tx.setSenderIfNotSet(ZERO_ADDRESS);
	tx.add(deepbook.poolBookParams(ctx.config.pool_key));
	tx.add(deepbook.getLevel2TicksFromMid(ctx.config.pool_key, 6));
	tx.add(deepbook.midPrice(ctx.config.pool_key));

	const result = await ctx.inspect(tx);

	const tickSizeRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 0)));
	const lotSizeRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 1)));
	const minSizeRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 2)));
	const tickSize = (tickSizeRaw * ctx.baseCoin.scalar) / ctx.quoteCoin.scalar / FLOAT_SCALAR;
	const lotSize = lotSizeRaw / ctx.baseCoin.scalar;
	const minSize = minSizeRaw / ctx.baseCoin.scalar;

	const bidPrices = bcs.vector(bcs.U64).parse(ctx.returnBytes(result, 1, 0));
	const askPrices = bcs.vector(bcs.U64).parse(ctx.returnBytes(result, 1, 2));

	const bestBid =
		bidPrices.length > 0
			? (Number(bidPrices[0]) * ctx.baseCoin.scalar) / ctx.quoteCoin.scalar / FLOAT_SCALAR
			: 0;
	const bestAsk =
		askPrices.length > 0
			? (Number(askPrices[0]) * ctx.baseCoin.scalar) / ctx.quoteCoin.scalar / FLOAT_SCALAR
			: 0;

	const midRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 2, 0)));
	const midPrice = (midRaw * ctx.baseCoin.scalar) / ctx.quoteCoin.scalar / FLOAT_SCALAR;

	if (bestBid <= 0 || bestAsk <= 0) {
		throw new Error('Missing bid/ask levels from DeepBook mid-price inspect');
	}

	return { bestBid, bestAsk, tickSize, lotSize, minSize, midPrice };
}

export async function getOrderBookTopFromApi(
	ctx: DeepBookInternalContext,
	accounts: Partial<Record<BotAccountKey, ManagedAccount>>
): Promise<OrderBookTop> {
	const url = `${ctx.config.deeptrade_orderbook_api_base.replace(/\/$/, '')}/orderbook_by_id/${ctx.pool.address}?level=2&depth=1`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to load orderbook fallback: ${response.status}`);
	}

	const payload = (await response.json()) as Record<string, any>;
	const bestBid = Number(payload?.bids?.[0]?.[0] ?? payload?.data?.bids?.[0]?.[0] ?? 0);
	const bestAsk = Number(payload?.asks?.[0]?.[0] ?? payload?.data?.asks?.[0]?.[0] ?? 0);
	const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
	let tickSize = ctx.lastOrderBookTop?.tickSize ?? 0;
	let lotSize = ctx.lastOrderBookTop?.lotSize ?? 0;
	let minSize = ctx.lastOrderBookTop?.minSize ?? 0;

	if (tickSize <= 0 || lotSize <= 0 || minSize <= 0) {
		const poolParamsTx = new Transaction();
		poolParamsTx.setSenderIfNotSet(ZERO_ADDRESS);
		poolParamsTx.add(ctx.sdk(accounts).deepbook.poolBookParams(ctx.config.pool_key));
		const poolParams = await ctx.inspect(poolParamsTx);
		const tickSizeRaw = Number(bcs.U64.parse(ctx.returnBytes(poolParams, 0, 0)));
		const lotSizeRaw = Number(bcs.U64.parse(ctx.returnBytes(poolParams, 0, 1)));
		const minSizeRaw = Number(bcs.U64.parse(ctx.returnBytes(poolParams, 0, 2)));
		tickSize = (tickSizeRaw * ctx.baseCoin.scalar) / ctx.quoteCoin.scalar / FLOAT_SCALAR;
		lotSize = lotSizeRaw / ctx.baseCoin.scalar;
		minSize = minSizeRaw / ctx.baseCoin.scalar;
	}

	return { bestBid, bestAsk, tickSize, lotSize, minSize, midPrice };
}

export async function getOrderBookTop(
	ctx: DeepBookInternalContext,
	accounts: Partial<Record<BotAccountKey, ManagedAccount>>
): Promise<OrderBookTop> {
	try {
		const top = await getOrderBookTopFromChain(ctx, accounts);
		ctx.lastOrderBookTop = top;
		return top;
	} catch (chainError) {
		try {
			const top = await getOrderBookTopFromApi(ctx, accounts);
			ctx.lastOrderBookTop = top;
			return top;
		} catch (apiError) {
			if (ctx.lastOrderBookTop) {
				return ctx.lastOrderBookTop;
			}

			const chainMessage = chainError instanceof Error ? chainError.message : String(chainError);
			const apiMessage = apiError instanceof Error ? apiError.message : String(apiError);
			throw new Error(
				`Failed to load orderbook from chain (${chainMessage}) and fallback (${apiMessage})`
			);
		}
	}
}

export async function estimateMarketQuoteOut(
	ctx: DeepBookInternalContext,
	baseQuantity: number
): Promise<number> {
	if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
		return 0;
	}

	const { deepbook } = ctx.sdk({});
	const tx = new Transaction();
	tx.setSenderIfNotSet(ZERO_ADDRESS);
	tx.add(deepbook.getQuantityOut(ctx.config.pool_key, baseQuantity, 0));
	const result = await ctx.inspect(tx);
	const quoteOutRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 1)));
	return round(quoteOutRaw / ctx.quoteCoin.scalar, 9);
}

export async function estimateMarketBaseOut(
	ctx: DeepBookInternalContext,
	quoteQuantity: number
): Promise<number> {
	if (!Number.isFinite(quoteQuantity) || quoteQuantity <= 0) {
		return 0;
	}

	const { deepbook } = ctx.sdk({});
	const tx = new Transaction();
	tx.setSenderIfNotSet(ZERO_ADDRESS);
	tx.add(deepbook.getQuantityOut(ctx.config.pool_key, 0, quoteQuantity));
	const result = await ctx.inspect(tx);
	const baseOutRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 0)));
	return round(baseOutRaw / ctx.baseCoin.scalar, 9);
}

export async function estimateMarketBuyQuantityForBaseTarget(
	ctx: DeepBookInternalContext,
	input: {
		targetBase: number;
		maxQuoteQuantity: number;
		lotSize: number;
		minSize: number;
	}
): Promise<{ quantity: number; quoteIn: number } | null> {
	const { targetBase, maxQuoteQuantity, lotSize, minSize } = input;
	if (
		!Number.isFinite(targetBase) ||
		targetBase <= 0 ||
		!Number.isFinite(maxQuoteQuantity) ||
		maxQuoteQuantity <= 0
	) {
		return null;
	}

	const maxBaseOut = await estimateMarketBaseOut(ctx, maxQuoteQuantity);
	if (maxBaseOut <= 0) {
		return null;
	}
	const coverageTargetBase = marketBuyCoverageTargetBase(targetBase, lotSize, minSize);
	if (coverageTargetBase <= 0) {
		return null;
	}
	if (maxBaseOut < coverageTargetBase) {
		return { quantity: maxBaseOut, quoteIn: maxQuoteQuantity };
	}

	let lowQuoteAtomic = 1;
	let highQuoteAtomic = Math.round(maxQuoteQuantity * ctx.quoteCoin.scalar);
	let bestQuoteIn = maxQuoteQuantity;
	let bestBaseOut = maxBaseOut;

	while (lowQuoteAtomic <= highQuoteAtomic) {
		const midAtomic = Math.floor((lowQuoteAtomic + highQuoteAtomic) / 2);
		const candidateQuote = round(midAtomic / ctx.quoteCoin.scalar, 6);
		const candidateBaseOut = await estimateMarketBaseOut(ctx, candidateQuote);
		if (candidateBaseOut >= coverageTargetBase) {
			bestQuoteIn = candidateQuote;
			bestBaseOut = candidateBaseOut;
			highQuoteAtomic = midAtomic - 1;
		} else {
			lowQuoteAtomic = midAtomic + 1;
		}
	}

	const normalizedBase =
		lotSize > 0 ? round(Math.floor(bestBaseOut / lotSize) * lotSize, 9) : round(bestBaseOut, 9);
	if (normalizedBase <= 0 || normalizedBase < minSize) {
		return { quantity: bestBaseOut, quoteIn: bestQuoteIn };
	}

	return { quantity: normalizedBase, quoteIn: bestQuoteIn };
}

export async function getPoolTradeParams(
	ctx: DeepBookInternalContext
): Promise<{ takerFee: number; makerFee: number }> {
	const { deepbook } = ctx.sdk({});
	const tx = new Transaction();
	tx.setSenderIfNotSet(ZERO_ADDRESS);
	tx.add(deepbook.poolTradeParams(ctx.config.pool_key));
	const result = await ctx.inspect(tx);
	const takerFeeRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 0)));
	const makerFeeRaw = Number(bcs.U64.parse(ctx.returnBytes(result, 0, 1)));

	return {
		takerFee: takerFeeRaw / FLOAT_SCALAR,
		makerFee: makerFeeRaw / FLOAT_SCALAR
	};
}

export async function estimateMarketSellQuantityForQuoteTarget(
	ctx: DeepBookInternalContext,
	input: {
		targetQuote: number;
		maxBaseQuantity: number;
		lotSize: number;
		minSize: number;
	}
): Promise<{ quantity: number; quoteOut: number } | null> {
	const { targetQuote, maxBaseQuantity, lotSize, minSize } = input;
	if (
		!Number.isFinite(targetQuote) ||
		targetQuote <= 0 ||
		!Number.isFinite(maxBaseQuantity) ||
		maxBaseQuantity <= 0
	) {
		return null;
	}

	const normalizedMax =
		lotSize > 0
			? round(Math.floor(maxBaseQuantity / lotSize) * lotSize, 9)
			: round(maxBaseQuantity, 9);
	if (normalizedMax <= 0 || normalizedMax < minSize) {
		return null;
	}

	const maxQuoteOut = await estimateMarketQuoteOut(ctx, normalizedMax);
	if (maxQuoteOut <= 0) {
		return null;
	}
	if (maxQuoteOut < targetQuote || lotSize <= 0) {
		return { quantity: normalizedMax, quoteOut: maxQuoteOut };
	}

	let lowLots = Math.max(1, Math.ceil(minSize / lotSize));
	let highLots = Math.floor(normalizedMax / lotSize);
	let bestQuantity = normalizedMax;
	let bestQuoteOut = maxQuoteOut;

	while (lowLots <= highLots) {
		const midLots = Math.floor((lowLots + highLots) / 2);
		const candidateQuantity = round(midLots * lotSize, 9);
		const candidateQuoteOut = await estimateMarketQuoteOut(ctx, candidateQuantity);
		if (candidateQuoteOut >= targetQuote) {
			bestQuantity = candidateQuantity;
			bestQuoteOut = candidateQuoteOut;
			highLots = midLots - 1;
		} else {
			lowLots = midLots + 1;
		}
	}

	return { quantity: bestQuantity, quoteOut: bestQuoteOut };
}

export async function getLivePriceQuote(
	ctx: DeepBookInternalContext,
	accounts: Partial<Record<BotAccountKey, ManagedAccount>>
): Promise<LivePriceQuote> {
	try {
		const top = await getOrderBookTopFromChain(ctx, accounts);
		ctx.lastOrderBookTop = top;
		return {
			price: top.midPrice > 0 ? top.midPrice : (top.bestBid + top.bestAsk) / 2,
			source: 'deepbook-mid'
		};
	} catch {
		try {
			const top = await getOrderBookTopFromApi(ctx, accounts);
			ctx.lastOrderBookTop = top;
			return {
				price: top.midPrice > 0 ? top.midPrice : (top.bestBid + top.bestAsk) / 2,
				source: 'deeptrade-api'
			};
		} catch {
			if (!ctx.lastOrderBookTop) {
				throw new Error('Failed to load live price from both chain and fallback sources');
			}

			return {
				price:
					ctx.lastOrderBookTop.midPrice > 0
						? ctx.lastOrderBookTop.midPrice
						: (ctx.lastOrderBookTop.bestBid + ctx.lastOrderBookTop.bestAsk) / 2,
				source: 'deepbook-mid'
			};
		}
	}
}

export async function getLivePrice(
	ctx: DeepBookInternalContext,
	accounts: Partial<Record<BotAccountKey, ManagedAccount>>
): Promise<number> {
	const quote = await getLivePriceQuote(ctx, accounts);
	return quote.price;
}
