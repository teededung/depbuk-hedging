import type { BotAccountKey, BotLogEntry, CycleOrderRecord, DashboardStats } from './types.js';

export const MANAGER_CACHE_DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000;

export class StopRequestedError extends Error {
	constructor() {
		super('Stop requested');
	}
}

export class FatalRuntimeError extends Error {
	readonly causeError: unknown;

	constructor(message: string, causeError?: unknown) {
		super(message);
		this.name = 'FatalRuntimeError';
		this.causeError = causeError;
	}
}

export function round(value: number, decimals = 6): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

export function shortId(value?: string): string {
	if (!value) {
		return 'unknown';
	}
	return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function cleanupRunId(): string {
	return `cleanup-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export function extractErrorDebugMeta(error: unknown): Record<string, unknown> | null {
	if (typeof error !== 'object' || error === null || !('debugMeta' in error)) {
		return null;
	}

	const debugMeta = (error as { debugMeta?: unknown }).debugMeta;
	if (typeof debugMeta !== 'object' || debugMeta === null) {
		return null;
	}

	return debugMeta as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function stringArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((item) => stringValue(item)).filter((item): item is string => item !== null);
}

export function summarizeAggregatorDebugMeta(
	debugMeta: Record<string, unknown> | null
): string | null {
	if (!debugMeta) {
		return null;
	}

	const quoteSummary = debugMeta.quoteSummary;
	if (typeof quoteSummary !== 'object' || quoteSummary === null) {
		return null;
	}

	const quoteMeta = quoteSummary as Record<string, unknown>;
	const provider = stringValue(quoteMeta.provider);
	const quoteId = stringValue(quoteMeta.quoteId);
	const rpcUrl = stringValue(quoteMeta.rpcUrl);
	const routeDexes = stringArrayValue(quoteMeta.routeDexes).slice(0, 3);
	const routeHops = stringArrayValue(quoteMeta.routeHops).slice(0, 1);
	const parts: string[] = [];

	if (provider) {
		parts.push(`provider=${provider}`);
	}
	if (routeDexes.length > 0) {
		parts.push(`dex=${routeDexes.join('>')}`);
	}
	if (routeHops.length > 0) {
		parts.push(`hops=${routeHops[0]}`);
	}
	if (quoteId) {
		parts.push(`quote=${quoteId}`);
	}
	if (rpcUrl) {
		parts.push(`rpc=${rpcUrl}`);
	}

	return parts.length > 0 ? `Aggregator context: ${parts.join(' | ')}` : null;
}

export function randomBetween(min: number, max: number): number {
	return Math.random() * (max - min) + min;
}

export function randomInt(min: number, max: number): number {
	return Math.floor(randomBetween(min, max + 1));
}

export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}

	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const runWorker = async () => {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) {
				return;
			}

			results[currentIndex] = await worker(items[currentIndex], currentIndex);
		}
	};

	await Promise.all(Array.from({ length: limit }, () => runWorker()));
	return results;
}

export function createEmptyStats(): DashboardStats {
	return {
		totalVolumeAllTime: 0,
		totalVolumeToday: 0,
		totalVolumeAccountA: 0,
		totalVolumeAccountB: 0,
		sessionPnl: 0,
		sessionFees: 0,
		sessionGas: 0,
		cyclesCompleted: 0,
		updatedAt: nowIso()
	};
}

export function sumCycleOrderGasUsd(orders: CycleOrderRecord[]): number {
	return round(
		orders.reduce((sum, order) => sum + (Number.isFinite(order.gasUsedUsd) ? (order.gasUsedUsd ?? 0) : 0), 0),
		6
	);
}

export function sumCycleOrderFeesUsd(orders: CycleOrderRecord[]): number {
	return round(
		orders.reduce(
			(sum, order) => sum + (Number.isFinite(order.paidFeesQuote) ? (order.paidFeesQuote ?? 0) : 0),
			0
		),
		6
	);
}

export function sumFilledCycleOrderVolumeUsd(orders: CycleOrderRecord[]): number {
	return round(
		orders.reduce(
			(sum, order) =>
				sum +
				(order.status === 'filled' && Number.isFinite(order.notionalUsd) ? (order.notionalUsd ?? 0) : 0),
			0
		),
		4
	);
}

export function realizedTradingPnlUsdFromFilledOrders(orders: CycleOrderRecord[]): number {
	type SidePhaseSummary = {
		openQty: number;
		openNotional: number;
		closeQty: number;
		closeNotional: number;
	};

	const summary: Record<'LONG' | 'SHORT', SidePhaseSummary> = {
		LONG: { openQty: 0, openNotional: 0, closeQty: 0, closeNotional: 0 },
		SHORT: { openQty: 0, openNotional: 0, closeQty: 0, closeNotional: 0 }
	};

	for (const order of orders) {
		if (order.status !== 'filled') {
			continue;
		}
		const quantity = Number.isFinite(order.filledQuantity)
			? (order.filledQuantity ?? 0)
			: Number.isFinite(order.quantity)
				? (order.quantity ?? 0)
				: 0;
		const price = Number.isFinite(order.filledPrice)
			? (order.filledPrice ?? 0)
			: Number.isFinite(order.price)
				? (order.price ?? 0)
				: 0;
		if (quantity <= 0 || price <= 0) {
			continue;
		}

		const bucket = summary[order.side];
		if (order.phase === 'OPEN') {
			bucket.openQty += quantity;
			bucket.openNotional += quantity * price;
			continue;
		}
		bucket.closeQty += quantity;
		bucket.closeNotional += quantity * price;
	}

	const avg = (notional: number, quantity: number): number => (quantity > 0 ? notional / quantity : 0);
	const longOpenPrice = avg(summary.LONG.openNotional, summary.LONG.openQty);
	const longClosePrice = avg(summary.LONG.closeNotional, summary.LONG.closeQty);
	const shortOpenPrice = avg(summary.SHORT.openNotional, summary.SHORT.openQty);
	const shortClosePrice = avg(summary.SHORT.closeNotional, summary.SHORT.closeQty);
	const matchedLongQty = Math.min(summary.LONG.openQty, summary.LONG.closeQty);
	const matchedShortQty = Math.min(summary.SHORT.openQty, summary.SHORT.closeQty);

	return round(
		matchedLongQty * (longClosePrice - longOpenPrice) +
			matchedShortQty * (shortOpenPrice - shortClosePrice),
		6
	);
}

export function freshestLogs(currentLogs: BotLogEntry[], candidateLogs: BotLogEntry[]): BotLogEntry[] {
	const currentLatestId = currentLogs[currentLogs.length - 1]?.id ?? 0;
	const candidateLatestId = candidateLogs[candidateLogs.length - 1]?.id ?? 0;
	return candidateLatestId < currentLatestId ? currentLogs : candidateLogs;
}

export function defaultAccountLabel(account: BotAccountKey): string {
	return account === 'accountA' ? 'Account A (Long)' : 'Account B (Short)';
}

export function normalizeQuantity(quantity: number, lotSize: number, minSize: number): number {
	if (!Number.isFinite(quantity) || quantity <= 0) {
		throw new Error('Invalid quantity');
	}
	const size = lotSize > 0 ? Math.floor(quantity / lotSize) * lotSize : quantity;
	const normalized = round(size, 9);
	if (normalized <= 0 || normalized < minSize) {
		throw new Error('Configured notional is smaller than pool minimum size');
	}
	return normalized;
}

export function normalizeCleanupQuantity(
	quantity: number,
	lotSize: number,
	minSize: number,
	options: { roundUp?: boolean; maxQuantity?: number } = {}
): number | null {
	if (!Number.isFinite(quantity) || quantity <= 0) {
		return null;
	}

	const size =
		lotSize > 0
			? (options.roundUp ? Math.ceil(quantity / lotSize) : Math.floor(quantity / lotSize)) * lotSize
			: quantity;
	const capped =
		options.maxQuantity && options.maxQuantity > 0 ? Math.min(size, options.maxQuantity) : size;
	const normalized = round(capped, 9);
	if (normalized <= 0 || normalized < minSize) {
		return null;
	}
	return normalized;
}

export function isFatalRuntimeErrorMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return normalized.includes('not enough coins of type') || normalized.includes('no valid gas coins found');
}

export function isRateLimitedErrorMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes('status code: 429') ||
		normalized.includes('unexpected status code: 429') ||
		normalized.includes('rate limit') ||
		normalized.includes('too many requests')
	);
}

export function isPostOnlyCrossErrorMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes('order_info') &&
		normalized.includes('assert_execution') &&
		normalized.includes('}, 5)')
	);
}

export function isMarginWithdrawNotReadyErrorMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		(normalized.includes('identifier("margin_manager")') ||
			normalized.includes('margin_manager::withdraw')) &&
		normalized.includes('some("withdraw")') &&
		normalized.includes('}, 8)')
	);
}

export function isInsufficientCycleFundingErrorMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.startsWith('account a needs ') ||
		normalized.startsWith('account b needs ') ||
		normalized.includes('funding short. cannot cover even the minimum notional')
	);
}

export function retryDelayMs(message: string, attempt: number): number {
	if (isRateLimitedErrorMessage(message)) {
		return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1));
	}
	if (isMarginWithdrawNotReadyErrorMessage(message)) {
		return Math.min(20000, 7000 * Math.max(1, attempt));
	}
	return attempt * 1000;
}

export function makerBidPrice(bestBid: number, bestAsk: number, tickSize: number): number {
	const spread = bestAsk - bestBid;
	if (spread > tickSize * 2) {
		return round(bestBid + tickSize, 6);
	}
	return round(bestBid, 6);
}

export function makerAskPrice(bestBid: number, bestAsk: number, tickSize: number): number {
	const spread = bestAsk - bestBid;
	if (spread > tickSize * 2) {
		return round(bestAsk - tickSize, 6);
	}
	return round(bestAsk, 6);
}

export function clientOrderId(): string {
	const numeric = BigInt(Date.now()) * 1000n + BigInt(randomInt(100, 999));
	return numeric.toString();
}
