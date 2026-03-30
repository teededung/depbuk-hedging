// @vitest-environment jsdom
// @vitest-environment-options {"customExportConditions":["browser"]}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';

import type { AutoBalancePreview, RuntimeSnapshot } from '$lib/types/bot.js';
import AutoBalanceModal from './AutoBalanceModal.svelte';

function createPreview(): AutoBalancePreview {
	return {
		targetCycles: 2,
		referencePrice: 10,
		accountA: {
			account: 'accountA',
			label: 'Account A',
			targetAsset: 'SUI',
			sourceAsset: 'USDC',
			workingCapitalAmount: 11,
			reserveAmount: 0.05,
			reservePerExtraCycleUsd: 0.25,
			targetAmount: 11.05,
			currentAmount: 1,
			shortfallAmount: 10.05,
			estimatedSourceAmount: 110,
			availableSourceAmount: 150,
			state: 'planned'
		},
		accountB: {
			account: 'accountB',
			label: 'Account B',
			targetAsset: 'USDC',
			sourceAsset: 'SUI',
			workingCapitalAmount: 110,
			reserveAmount: 0.5,
			reservePerExtraCycleUsd: 0.25,
			targetAmount: 110.5,
			currentAmount: 220,
			shortfallAmount: 0,
			estimatedSourceAmount: 0,
			availableSourceAmount: 50,
			state: 'ready'
		},
		canExecute: true,
		message:
			'Ready to prepare funding. Targets use one-cycle working capital plus a reserve buffer, not cumulative spend across cycles.'
	};
}

function createSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
	return {
		lifecycle: 'STOPPED',
		liveLabel: 'Offline',
		runLabel: 'STOPPED',
		message: 'snapshot',
		stats: {
			totalVolumeAllTime: 0,
			totalVolumeToday: 0,
			totalVolumeAccountA: 0,
			totalVolumeAccountB: 0,
			sessionPnl: 0,
			sessionFees: 0,
			sessionGas: 0,
			cyclesCompleted: 0,
			updatedAt: new Date(0).toISOString()
		},
		price: {
			source: 'static',
			price: 10,
			updatedAt: new Date(0).toISOString(),
			uptimeSeconds: 0
		},
		balances: {
			source: 'wallet',
			accountA: {
				address: '0xA',
				sui: 10,
				usdc: 10,
				totalUsdc: 110,
				updatedAt: new Date(0).toISOString()
			},
			accountB: {
				address: '0xB',
				sui: 10,
				usdc: 10,
				totalUsdc: 110,
				updatedAt: new Date(0).toISOString()
			},
			totalUsdc: 220,
			updatedAt: new Date(0).toISOString()
		},
		preflight: {
			state: 'ready',
			ready: true,
			referencePrice: 10,
			plannedNotionalUsd: 100,
			estimatedQuantitySui: 10,
			configuredNotionalUsd: 100,
			minNotionalUsd: 100,
			effectiveNotionalUsd: 100,
			autoReduced: false,
			accountA: {
				account: 'accountA',
				label: 'Account A',
				requiredAsset: 'SUI',
				requiredAmount: 0,
				availableAmount: 0,
				missingAmount: 0,
				state: 'ready',
				autoSwapEnabled: true,
				openOrdersCount: 0,
				baseAsset: 0,
				quoteAsset: 0,
				baseDebt: 0,
				quoteDebt: 0,
				updatedAt: new Date(0).toISOString()
			},
			accountB: {
				account: 'accountB',
				label: 'Account B',
				requiredAsset: 'USDC',
				requiredAmount: 0,
				availableAmount: 0,
				missingAmount: 0,
				state: 'ready',
				autoSwapEnabled: true,
				openOrdersCount: 0,
				baseAsset: 0,
				quoteAsset: 0,
				baseDebt: 0,
				quoteDebt: 0,
				updatedAt: new Date(0).toISOString()
			},
			updatedAt: new Date(0).toISOString()
		},
		autoTopup: {
			status: 'idle',
			account: null,
			updatedAt: new Date(0).toISOString()
		},
		activeCycle: null,
		history: [],
		logs: [],
		config: null,
		updatedAt: new Date(0).toISOString(),
		...overrides
	};
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('AutoBalanceModal', () => {
	it('calls onExecuted with the returned snapshot after a successful execute', async () => {
		const onExecuted = vi.fn();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ preview: createPreview() })
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					snapshot: createSnapshot({ message: 'post-balance snapshot' })
				})
			});

		vi.stubGlobal('fetch', fetchMock);

		render(AutoBalanceModal, {
			open: true,
			onClose: () => {},
			onExecuted
		});

		expect(fetchMock).not.toHaveBeenCalled();
		screen.getByRole('button', { name: 'Refresh' }).click();
		await screen.findByText(/Ready to prepare funding\./);
		const confirmButton = screen.getByRole('button', { name: 'Confirm Prep' });
		await waitFor(() => {
			expect(confirmButton.hasAttribute('disabled')).toBe(false);
		});
		confirmButton.click();

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(onExecuted).toHaveBeenCalledTimes(1);
		});
		expect(onExecuted).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'post-balance snapshot' })
		);
	});

	it('does not call onExecuted when execute fails', async () => {
		const onExecuted = vi.fn();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ preview: createPreview() })
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				json: async () => ({ error: 'swap failed' })
			});

		vi.stubGlobal('fetch', fetchMock);

		render(AutoBalanceModal, {
			open: true,
			onClose: () => {},
			onExecuted
		});

		expect(fetchMock).not.toHaveBeenCalled();
		screen.getByRole('button', { name: 'Refresh' }).click();
		await screen.findByText(/Ready to prepare funding\./);
		const confirmButton = screen.getByRole('button', { name: 'Confirm Prep' });
		await waitFor(() => {
			expect(confirmButton.hasAttribute('disabled')).toBe(false);
		});
		confirmButton.click();

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		await screen.findByText('swap failed');
		expect(onExecuted).not.toHaveBeenCalled();
	});

	it('does not auto-load preview on open', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		render(AutoBalanceModal, {
			open: true,
			onClose: () => {},
			onExecuted: () => {}
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Enter the target cycles you want, then press/i)
		).toBeTruthy();
	});
});
