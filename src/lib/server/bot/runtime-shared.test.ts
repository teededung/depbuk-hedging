import { describe, expect, it } from 'vitest';

import {
	freshestLogs,
	isMarginWithdrawNotReadyErrorMessage,
	isPostOnlyCrossErrorMessage,
	isRateLimitedErrorMessage,
	makerAskPrice,
	makerBidPrice,
	normalizeCleanupQuantity,
	normalizeQuantity,
	retryDelayMs,
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
