// @vitest-environment jsdom
// @vitest-environment-options {"customExportConditions":["browser"]}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';

import type { LogSummary } from '../_helpers/page-view.js';
import RuntimeLogSummaryRow from './RuntimeLogSummaryRow.svelte';

const baseSummary = (overrides: Partial<LogSummary> = {}): LogSummary => ({
	key: 'warn:summary',
	message: 'LONG open market order failed.',
	level: 'warn',
	logs: [
		{
			id: 1,
			level: 'warn',
			message: 'LONG open market order failed.',
			meta: {
				account: 'test-account-a',
				accountKey: 'accountA',
				side: 'LONG',
				phase: 'OPEN',
				attempt: 1,
				executionMode: 'market',
				error: 'balance_manager::withdraw_with_proof failed'
			},
			createdAt: '2026-03-12T09:00:00.000Z'
		}
	],
	latestAt: '2026-03-12T09:00:00.000Z',
	attempts: [1],
	detail: 'Margin funding not available yet.',
	txDigest: undefined,
	isFatal: false,
	phase: 'OPEN',
	...overrides
});

afterEach(() => {
	cleanup();
});

beforeEach(() => {
	if (!Element.prototype.animate) {
		Element.prototype.animate = vi.fn(
			() =>
				({
					cancel: vi.fn(),
					finished: Promise.resolve(),
					play: vi.fn()
				}) as unknown as Animation
		);
	}
});

describe('RuntimeLogSummaryRow', () => {
	it('shows the retrying chip for the newest retryable warning row', () => {
		render(RuntimeLogSummaryRow, {
			summary: baseSummary(),
			showPhase: true,
			phaseLabel: 'Open',
			phaseClass: 'badge-info',
			isNewest: true,
			network: 'mainnet'
		});

		expect(screen.getByText('retrying')).toBeTruthy();
	});

	it('does not show the retrying chip for an older warning row', () => {
		render(RuntimeLogSummaryRow, {
			summary: baseSummary(),
			showPhase: true,
			phaseLabel: 'Open',
			phaseClass: 'badge-info',
			isNewest: false,
			network: 'mainnet'
		});

		expect(screen.queryByText('retrying')).toBeNull();
	});

	it('renders the cycle-start account label with primary highlight', () => {
		const view = render(RuntimeLogSummaryRow, {
			summary: baseSummary({
				key: 'cycle-start',
				message: 'Cycle #47 is starting for test-account-a.',
				level: 'info',
				logs: [
					{
						id: 2,
						level: 'info',
						message: 'Cycle #47 is starting for test-account-a.',
						meta: {
							account: 'test-account-a',
							accountKey: 'accountA',
							phase: 'OPEN'
						},
						createdAt: '2026-03-12T09:01:00.000Z'
					}
				],
				attempts: [],
				detail: undefined,
				phase: 'OPEN'
			}),
			showPhase: true,
			phaseLabel: 'Open',
			phaseClass: 'badge-info',
			isNewest: true,
			network: 'mainnet'
		});

		expect(view.container.textContent).toContain('Cycle #47 is starting for');
		expect(view.container.textContent).toContain('test-account-a');
		const pill = screen.getByText('test-account-a');
		expect(pill.tagName).toBe('SPAN');
		expect(pill.className).toContain('text-primary');
	});

	it('renders auto top-up account labels with primary highlight', () => {
		render(RuntimeLogSummaryRow, {
			summary: baseSummary({
				key: 'auto-topup-planned',
				message: 'Auto top-up swap planned for test-account-a.',
				level: 'info',
				logs: [
					{
						id: 3,
						level: 'info',
						message: 'Auto top-up swap planned for test-account-a.',
						meta: {
							account: 'test-account-a',
							accountKey: 'accountA',
							phase: 'OPEN'
						},
						createdAt: '2026-03-12T09:02:00.000Z'
					}
				],
				attempts: [],
				detail: undefined,
				phase: 'OPEN'
			}),
			showPhase: true,
			phaseLabel: 'Open',
			phaseClass: 'badge-info',
			isNewest: true,
			network: 'mainnet'
		});

		const label = screen.getByText('test-account-a');
		expect(label.tagName).toBe('SPAN');
		expect(label.className).toContain('text-primary');
	});

	it('does not highlight non-account text after for', () => {
		render(RuntimeLogSummaryRow, {
			summary: baseSummary({
				key: 'hold-fill',
				message: 'LONG leg is filled; waiting for hold window on cycle #51.',
				level: 'info',
				logs: [
					{
						id: 4,
						level: 'info',
						message: 'LONG leg is filled; waiting for hold window on cycle #51.',
						meta: {
							account: 'test-account-a',
							accountKey: 'accountA',
							side: 'LONG',
							phase: 'HOLD'
						},
						createdAt: '2026-03-12T09:03:00.000Z'
					}
				],
				attempts: [],
				detail: undefined,
				phase: 'HOLD'
			}),
			showPhase: true,
			phaseLabel: 'Hold',
			phaseClass: 'badge-success',
			isNewest: true,
			network: 'mainnet'
		});

		const holdText = screen.getByText('hold window on cycle #51', { exact: false });
		expect(holdText.className).not.toContain('text-primary');
	});

	it('renders cleanup account labels with primary highlight', () => {
		render(RuntimeLogSummaryRow, {
			summary: baseSummary({
				key: 'cleanup-strategy',
				message: 'Cleanup strategy selected for test-account-a: long_debt_close',
				level: 'info',
				logs: [
					{
						id: 5,
						level: 'info',
						message: 'Cleanup strategy selected for test-account-a: long_debt_close',
						meta: {
							account: 'test-account-a',
							accountKey: 'accountA',
							phase: 'CLOSE'
						},
						createdAt: '2026-03-12T09:04:00.000Z'
					}
				],
				attempts: [],
				detail: undefined,
				phase: 'CLOSE'
			}),
			showPhase: true,
			phaseLabel: 'Close',
			phaseClass: 'badge-warning',
			isNewest: true,
			network: 'mainnet'
		});

		const label = screen.getByText('test-account-a');
		expect(label.className).toContain('text-primary');
	});
});
