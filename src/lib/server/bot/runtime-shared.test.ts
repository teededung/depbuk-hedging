import { describe, expect, it } from 'vitest';

import {
	freshestLogs,
	isInsufficientCycleFundingErrorMessage,
	isMarginWithdrawNotReadyErrorMessage,
	isPostOnlyCrossErrorMessage,
	isRateLimitedErrorMessage,
	makerAskPrice,
	makerBidPrice,
	normalizeCleanupQuantity,
	normalizeQuantity,
	retryDelayMs,
	realizedTradingPnlUsdFromFilledOrders,
	summarizeAggregatorDebugMeta,
	sumCycleOrderFeesUsd,
	sumFilledCycleOrderVolumeUsd
} from './runtime-shared.js';

describe('runtime-shared', () => {
	it('detects post-only cross errors', () => {
		expect(isPostOnlyCrossErrorMessage('order_info::assert_execution ... }, 5)')).toBe(true);
		expect(isPostOnlyCrossErrorMessage('some other error')).toBe(false);
	});

	it('detects rate-limited errors', () => {
		expect(isRateLimitedErrorMessage('Unexpected status code: 429 from rpc')).toBe(true);
		expect(isRateLimitedErrorMessage('Too many requests')).toBe(true);
		expect(isRateLimitedErrorMessage('execution failed')).toBe(false);
	});

	it('detects margin withdraw-not-ready errors', () => {
		expect(
			isMarginWithdrawNotReadyErrorMessage(
				'Dry run failed ... Identifier("margin_manager") ... Some("withdraw") }, 8) in command 4'
			)
		).toBe(true);
		expect(isMarginWithdrawNotReadyErrorMessage('some other error')).toBe(false);
	});

	it('detects insufficient cycle funding errors that should not retry in a loop', () => {
		expect(
			isInsufficientCycleFundingErrorMessage(
				'Account A needs 25.3967 SUI but only has 1.9560 SUI and 21.9159 USDC available'
			)
		).toBe(true);
		expect(
			isInsufficientCycleFundingErrorMessage(
				'Funding short. Cannot cover even the minimum notional ($80.00). Deposit required.'
			)
		).toBe(true);
		expect(isInsufficientCycleFundingErrorMessage('Unexpected status code: 429')).toBe(false);
	});

	it('uses increasing retry delay for margin withdraw-not-ready errors', () => {
		const err =
			'Dry run failed ... Identifier("margin_manager") ... Some("withdraw") }, 8) in command 4';
		expect(retryDelayMs(err, 1)).toBe(7000);
		expect(retryDelayMs(err, 2)).toBe(14000);
	});

	it('summarizes aggregator debug metadata for readable UI/log context', () => {
		const summary = summarizeAggregatorDebugMeta({
			quoteSummary: {
				provider: 'BLUEFIN7K',
				routeDexes: ['CETUS', 'BLUEFIN'],
				routeHops: ['CETUS -> BLUEFIN'],
				quoteId: 'quote-123',
				rpcUrl: 'https://rpc.example'
			}
		});
		expect(summary).toContain('provider=BLUEFIN7K');
		expect(summary).toContain('dex=CETUS>BLUEFIN');
		expect(summary).toContain('hops=CETUS -> BLUEFIN');
		expect(summary).toContain('quote=quote-123');
		expect(summary).toContain('rpc=https://rpc.example');
	});

	it('returns null summary when debug metadata does not include quote summary', () => {
		expect(summarizeAggregatorDebugMeta(null)).toBeNull();
		expect(summarizeAggregatorDebugMeta({})).toBeNull();
		expect(summarizeAggregatorDebugMeta({ quoteSummary: null })).toBeNull();
	});

	it('calculates maker bid and ask prices from spread and tick size', () => {
		expect(makerBidPrice(10, 10.5, 0.1)).toBe(10.1);
		expect(makerBidPrice(10, 10.1, 0.1)).toBe(10);
		expect(makerAskPrice(10, 10.5, 0.1)).toBe(10.4);
		expect(makerAskPrice(10, 10.1, 0.1)).toBe(10.1);
	});

	it('normalizes maker quantities down to lot size and minimum size', () => {
		expect(normalizeQuantity(5.76, 0.25, 0.5)).toBe(5.75);
		expect(() => normalizeQuantity(0.1, 0.25, 0.5)).toThrow('Configured notional is smaller than pool minimum size');
	});

	it('normalizes cleanup quantities with cap and null for dust', () => {
		expect(normalizeCleanupQuantity(5.76, 0.25, 0.5)).toBe(5.75);
		expect(normalizeCleanupQuantity(5.76, 0.25, 0.5, { maxQuantity: 5.1 })).toBe(5.1);
		expect(normalizeCleanupQuantity(0.1, 0.25, 0.5)).toBeNull();
	});

	it('sums persisted paid fees from cycle orders', () => {
		expect(
			sumCycleOrderFeesUsd([
				{ paidFeesQuote: 0.012345 } as never,
				{ paidFeesQuote: 0.023456 } as never,
				{} as never
			])
		).toBe(0.035801);
	});

	it('sums only filled order notionals for live cycle volume', () => {
		expect(
			sumFilledCycleOrderVolumeUsd([
				{ status: 'filled', notionalUsd: 31.2188 } as never,
				{ status: 'filled', notionalUsd: 30.1591 } as never,
				{ status: 'open', notionalUsd: 99 } as never
			])
		).toBe(61.3779);
	});

	it('computes realized trading pnl from matched filled open/close quantities', () => {
		const pnl = realizedTradingPnlUsdFromFilledOrders([
			{ side: 'LONG', phase: 'OPEN', status: 'filled', filledQuantity: 10, filledPrice: 1 } as never,
			{ side: 'LONG', phase: 'CLOSE', status: 'filled', filledQuantity: 8, filledPrice: 1.2 } as never,
			{ side: 'SHORT', phase: 'OPEN', status: 'filled', filledQuantity: 6, filledPrice: 2 } as never,
			{ side: 'SHORT', phase: 'CLOSE', status: 'filled', filledQuantity: 6, filledPrice: 1.8 } as never
		]);
		expect(pnl).toBe(2.8);
	});

	it('ignores unmatched legs when estimating realized trading pnl for failed cycles', () => {
		const pnl = realizedTradingPnlUsdFromFilledOrders([
			{ side: 'LONG', phase: 'OPEN', status: 'filled', filledQuantity: 5, filledPrice: 1.05 } as never,
			{ side: 'SHORT', phase: 'OPEN', status: 'filled', filledQuantity: 7, filledPrice: 0.95 } as never
		]);
		expect(pnl).toBe(0);
	});

	it('keeps the newer log batch when a stale refresh returns older logs', () => {
		const currentLogs = [
			{ id: 10, level: 'info', message: 'old', meta: {}, createdAt: new Date(0).toISOString() },
			{ id: 11, level: 'info', message: 'new', meta: {}, createdAt: new Date(0).toISOString() }
		] as never;
		const candidateLogs = [
			{ id: 9, level: 'info', message: 'older', meta: {}, createdAt: new Date(0).toISOString() },
			{ id: 10, level: 'info', message: 'old', meta: {}, createdAt: new Date(0).toISOString() }
		] as never;

		expect(freshestLogs(currentLogs, candidateLogs)).toBe(currentLogs);
	});
});
