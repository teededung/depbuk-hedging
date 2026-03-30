/**
 * Pure helpers used across deepbook internal modules.
 * No side effects, no state, no RPC calls.
 */

import { normalizeSuiAddress } from '@mysten/sui/utils';

export function hexToBytes(value: string): Uint8Array {
	const normalized = value.startsWith('0x') ? value.slice(2) : value;
	return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

export function parseNumericString(value: unknown): number {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	return Number(value ?? 0);
}

export function extractVaaBytesFromAccumulatorMessage(accumulatorMessage: Uint8Array): Uint8Array {
	const dataView = new DataView(
		accumulatorMessage.buffer,
		accumulatorMessage.byteOffset,
		accumulatorMessage.byteLength
	);
	const trailingPayloadSize = dataView.getUint8(6);
	const vaaSizeOffset = 7 + trailingPayloadSize + 1;
	const vaaSize = dataView.getUint16(vaaSizeOffset, false);
	const vaaOffset = vaaSizeOffset + 2;
	return accumulatorMessage.subarray(vaaOffset, vaaOffset + vaaSize);
}

export function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function normalizeMaybeAddress(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0) {
		return null;
	}
	return normalizeSuiAddress(value);
}

export function toAtomicUnits(amount: number, scalar: number): bigint {
	return BigInt(Math.max(1, Math.ceil(amount * scalar)));
}

export function floorToAtomicUnits(amount: number, scalar: number): bigint {
	if (!Number.isFinite(amount) || amount <= 0) {
		return 0n;
	}
	return BigInt(Math.floor(amount * scalar));
}

export function netGasUsedMist(
	gasUsed:
		| {
				computationCost?: string;
				storageCost?: string;
				storageRebate?: string;
		  }
		| null
		| undefined
): bigint {
	return (
		BigInt(gasUsed?.computationCost ?? 0) +
		BigInt(gasUsed?.storageCost ?? 0) -
		BigInt(gasUsed?.storageRebate ?? 0)
	);
}

export function extractExecutionSummaryFromEvents(
	events: any[] | undefined,
	clientOrderId: string,
	baseScalar: number,
	quoteScalar: number
): { filledQuantity: number; filledQuoteQuantity: number; averageFillPrice: number } | null {
	if (!events) {
		return null;
	}

	for (const event of events) {
		if (!String(event.type ?? '').includes('::order_info::OrderInfo')) {
			continue;
		}

		const parsed = event.parsedJson as Record<string, unknown> | undefined;
		if (String(parsed?.client_order_id ?? '') !== clientOrderId) {
			continue;
		}

		const executedQuantity = parseNumericString(parsed?.executed_quantity);
		const cumulativeQuoteQuantity = parseNumericString(parsed?.cumulative_quote_quantity);
		if (executedQuantity <= 0 || cumulativeQuoteQuantity <= 0) {
			continue;
		}

		const filledQuantity = round(executedQuantity / baseScalar, 9);
		const filledQuoteQuantity = round(cumulativeQuoteQuantity / quoteScalar, 9);
		if (filledQuantity <= 0 || filledQuoteQuantity <= 0) {
			continue;
		}

		return {
			filledQuantity,
			filledQuoteQuantity,
			averageFillPrice: round(filledQuoteQuantity / filledQuantity, 9)
		};
	}

	let totalBaseQuantity = 0;
	let totalQuoteQuantity = 0;
	for (const event of events) {
		if (!String(event.type ?? '').includes('::order_info::OrderFilled')) {
			continue;
		}

		const parsed = event.parsedJson as Record<string, unknown> | undefined;
		if (String(parsed?.taker_client_order_id ?? '') !== clientOrderId) {
			continue;
		}

		totalBaseQuantity += parseNumericString(parsed?.base_quantity);
		totalQuoteQuantity += parseNumericString(parsed?.quote_quantity);
	}

	if (totalBaseQuantity <= 0 || totalQuoteQuantity <= 0) {
		return null;
	}

	const filledQuantity = round(totalBaseQuantity / baseScalar, 9);
	const filledQuoteQuantity = round(totalQuoteQuantity / quoteScalar, 9);
	if (filledQuantity <= 0 || filledQuoteQuantity <= 0) {
		return null;
	}

	return {
		filledQuantity,
		filledQuoteQuantity,
		averageFillPrice: round(filledQuoteQuantity / filledQuantity, 9)
	};
}

export function buildLongCloseMarketRepayPlan(input: {
	targetQuoteDebt: number;
	quoteAsset: number;
	maxBaseQuantity: number;
	estimatedSellQuantity: { quantity: number; quoteOut: number } | null;
	lotSize?: number;
}): {
	netQuoteDebt: number;
	computedSellQuantity: number;
	estimatedQuoteOut: number;
} {
	const targetQuoteDebt = Math.max(input.targetQuoteDebt, 0);
	const quoteAsset = Math.max(input.quoteAsset, 0);
	const maxBaseQuantity = round(Math.max(input.maxBaseQuantity, 0), 9);
	const netQuoteDebt = round(Math.max(targetQuoteDebt - quoteAsset, 0), 6);

	if (netQuoteDebt <= 0 || maxBaseQuantity <= 0) {
		return {
			netQuoteDebt,
			computedSellQuantity: 0,
			estimatedQuoteOut: 0
		};
	}

	const estimatedSellQuantity = round(
		Math.max(input.estimatedSellQuantity?.quantity ?? maxBaseQuantity, 0),
		9
	);
	const lotSize = round(Math.max(input.lotSize ?? 0, 0), 9);
	const bufferedSellQuantity =
		lotSize > 0 && estimatedSellQuantity < maxBaseQuantity
			? round(Math.min(maxBaseQuantity, estimatedSellQuantity + lotSize), 9)
			: estimatedSellQuantity;

	return {
		netQuoteDebt,
		computedSellQuantity: round(Math.min(bufferedSellQuantity, maxBaseQuantity), 9),
		estimatedQuoteOut: round(Math.max(input.estimatedSellQuantity?.quoteOut ?? 0, 0), 9)
	};
}

/**
 * DeepTrade-aligned short close planning.
 *
 * The market buy targets the full short debt, not `baseDebt - baseAsset`.
 * After the market buy, a single `repay_base(None)` lets the protocol repay
 * the maximum available base against debt inside the same PTB.
 *
 * Iteration 5: removed `repayBaseUpperBound`; the PTB now uses `None` (repay-all)
 * instead of a bounded amount, eliminating residual-debt dust that caused
 * withdraw failures in cycle 38.
 */
export function buildShortCloseMarketRepayPlan(input: {
	targetBaseDebt: number;
	baseAsset: number;
	quoteAsset: number;
	maxQuoteQuantity: number;
	estimatedBuyQuantity: { quantity: number; quoteIn: number } | null;
}): {
	targetBaseDebt: number;
	computedQuoteBudget: number;
	computedBuyQuantity: number;
} {
	const targetBaseDebt = round(Math.max(input.targetBaseDebt, 0), 9);
	const maxQuoteQuantity = round(Math.max(input.maxQuoteQuantity, 0), 6);

	if (targetBaseDebt <= 0 || maxQuoteQuantity <= 0) {
		return {
			targetBaseDebt,
			computedQuoteBudget: 0,
			computedBuyQuantity: 0
		};
	}

	const estimatedQuoteIn = round(
		Math.max(input.estimatedBuyQuantity?.quoteIn ?? maxQuoteQuantity, 0),
		6
	);

	return {
		targetBaseDebt,
		computedQuoteBudget: round(Math.min(estimatedQuoteIn, maxQuoteQuantity), 6),
		computedBuyQuantity: round(Math.max(input.estimatedBuyQuantity?.quantity ?? 0, 0), 9)
	};
}

/**
 * @deprecated Iteration 4 removed pre-repay from short close.
 * Kept only for backward-compatible test references.
 */
export function buildShortCloseBaseRepayPlan(input: {
	targetBaseDebt: number;
	baseAsset: number;
}): {
	preRepayBaseQuantity: number;
	remainingBaseDebtTarget: number;
} {
	const targetBaseDebt = Math.max(input.targetBaseDebt, 0);
	const baseAsset = Math.max(input.baseAsset, 0);
	const preRepayBaseQuantity = round(Math.min(targetBaseDebt, baseAsset), 9);

	return {
		preRepayBaseQuantity,
		remainingBaseDebtTarget: round(Math.max(targetBaseDebt - preRepayBaseQuantity, 0), 9)
	};
}

export function marketBuyCoverageTargetBase(
	targetBase: number,
	lotSize: number,
	minSize: number
): number {
	const positiveTarget = Math.max(targetBase, 0);
	if (positiveTarget <= 0) {
		return 0;
	}

	const roundedToLot = lotSize > 0 ? Math.ceil(positiveTarget / lotSize) * lotSize : positiveTarget;
	return round(Math.max(roundedToLot, Math.max(minSize, 0)), 9);
}

export function computeBidQuoteBudget(input: {
	referencePrice: number;
	depositBase?: number;
	walletDepositBase?: number;
	depositQuote?: number;
	walletDepositQuote?: number;
	borrowQuote?: number;
}): number {
	const directQuoteBudget = round(
		Math.max(input.depositQuote ?? 0, 0) +
			Math.max(input.walletDepositQuote ?? 0, 0) +
			Math.max(input.borrowQuote ?? 0, 0),
		9
	);
	return directQuoteBudget;
}

export function buildAskMarketBorrowBaseCandidates(input: {
	quantity: number;
	currentBorrowBase: number;
	currentBaseFunding: number;
	takerFeeRate: number;
}): number[] {
	const quantity = Math.max(input.quantity, 0);
	const currentBorrowBase = round(Math.max(input.currentBorrowBase, 0), 9);
	const currentBaseFunding = Math.max(input.currentBaseFunding, 0);
	const takerFeeRate = Math.max(input.takerFeeRate, 0);
	const feeRateCandidates = [
		0,
		takerFeeRate,
		Math.max(takerFeeRate * 3, takerFeeRate + 0.00025),
		Math.max(takerFeeRate * 6, 0.001)
	];
	const seen = new Set<number>();
	const candidates: number[] = [];

	for (const feeRate of feeRateCandidates) {
		const requiredBaseFunding = quantity * (1 + feeRate);
		const additionalBorrowBase = Math.max(requiredBaseFunding - currentBaseFunding, 0);
		const candidate = round(currentBorrowBase + additionalBorrowBase, 9);
		if (candidate <= 0 || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		candidates.push(candidate);
	}

	if (candidates.length === 0) {
		return [currentBorrowBase];
	}

	return candidates;
}
