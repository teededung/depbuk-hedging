// @vitest-environment jsdom
// @vitest-environment-options {"customExportConditions":["browser"]}

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';

import type { RuntimeSnapshot } from '$lib/types/bot.js';

function createSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
	return {
		lifecycle: 'BOOTING',
		liveLabel: 'Offline',
		runLabel: 'BOOTING',
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
			price: 0,
			updatedAt: new Date(0).toISOString(),
			uptimeSeconds: 0
		},
		balances: {
			source: 'wallet',
			accountA: { address: '0xA', sui: 0, usdc: 0, totalUsdc: 0, updatedAt: new Date(0).toISOString() },
			accountB: { address: '0xB', sui: 0, usdc: 0, totalUsdc: 0, updatedAt: new Date(0).toISOString() },
			totalUsdc: 0,
			updatedAt: new Date(0).toISOString()
		},
		preflight: {
			state: 'waiting-price',
			ready: false,
			referencePrice: 0,
			plannedNotionalUsd: 0,
			estimatedQuantitySui: 0,
			configuredNotionalUsd: 0,
			minNotionalUsd: 0,
			effectiveNotionalUsd: 0,
			autoReduced: false,
			accountA: {
				account: 'accountA',
				label: 'Account A',
				requiredAsset: 'USDC',
				requiredAmount: 0,
				availableAmount: 0,
				missingAmount: 0,
				state: 'waiting-price',
				autoSwapEnabled: false,
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
				state: 'waiting-price',
				autoSwapEnabled: false,
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
});

describe('DashboardTopbar', () => {
	it('does not render the run label badge anymore', async () => {
		const { default: DashboardTopbar } = await import('./DashboardTopbar.svelte');

		render(DashboardTopbar, {
			snapshot: createSnapshot(),
			onOpenSettings: () => {},
			onOpenStart: () => {},
			onClean: () => {},
			settingsPending: false,
			settingsSaving: false,
			controlPending: false,
			preflightPending: false
		});

		expect(screen.queryByText('BOOTING')).toBeNull();
	});

	it('shows Start Bot and hides Stop before the bot starts', async () => {
		const { default: DashboardTopbar } = await import('./DashboardTopbar.svelte');

		render(DashboardTopbar, {
			snapshot: createSnapshot({
				lifecycle: 'STOPPED',
				runLabel: 'STOPPED'
			}),
			onOpenSettings: () => {},
			onOpenStart: () => {},
			onClean: () => {},
			settingsPending: false,
			settingsSaving: false,
			controlPending: false,
			preflightPending: false
		});

		expect(screen.getByRole('button', { name: 'Start Bot' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Stop & Clean' })).toBeTruthy();
	});

	it('hides Start Bot and keeps Stop & Clean after the bot has started', async () => {
		const { default: DashboardTopbar } = await import('./DashboardTopbar.svelte');

		render(DashboardTopbar, {
			snapshot: createSnapshot({
				lifecycle: 'RUNNING',
				runLabel: 'RUNNING'
			}),
			onOpenSettings: () => {},
			onOpenStart: () => {},
			onClean: () => {},
			settingsPending: false,
			settingsSaving: false,
			controlPending: false,
			preflightPending: false
		});

		expect(screen.queryByRole('button', { name: 'Start Bot' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Stop & Clean' })).toBeTruthy();
	});

	it('shows current/total cycles in the progress header', async () => {
		const { default: DashboardTopbar } = await import('./DashboardTopbar.svelte');

		render(DashboardTopbar, {
			snapshot: createSnapshot({
				lifecycle: 'RUNNING',
				runLabel: 'RUNNING',
				runCycleCount: 3,
				config: {
					network: 'mainnet',
					rpcUrl: 'https://rpc.example',
					experimentalDeeptradeLimitPtb: false,
					deeptradeOrderbookApiBase: 'https://api.example',
					poolKey: 'SUI_USDC',
					accountALabel: 'Account A',
					accountBLabel: 'Account B',
					hasPrivateKeyA: true,
					hasPrivateKeyB: true,
					notionalSizeUsd: 100,
					holdRangeSeconds: [30, 60],
					maxCycles: 10,
					slippageTolerance: 0.5,
					settingsApplyPending: false
				}
			}),
			onOpenSettings: () => {},
			onOpenStart: () => {},
			onClean: () => {},
			settingsPending: false,
			settingsSaving: false,
			controlPending: false,
			preflightPending: false
		});

		expect(screen.getByText('3/10')).toBeTruthy();
	});

	it('does not use global cycle number for current/total display', async () => {
		const { default: DashboardTopbar } = await import('./DashboardTopbar.svelte');

		render(DashboardTopbar, {
			snapshot: createSnapshot({
				lifecycle: 'RUNNING',
				runLabel: 'RUNNING',
				runCycleCount: 2,
				activeCycle: {
					cycleNumber: 276,
					stage: 'holding',
					price: 0.9,
					holdSecondsTarget: 60,
					plannedNotionalUsd: 100,
					currentQuantity: 10,
					updatedAt: new Date(0).toISOString()
				},
				config: {
					network: 'mainnet',
					rpcUrl: 'https://rpc.example',
					experimentalDeeptradeLimitPtb: false,
					deeptradeOrderbookApiBase: 'https://api.example',
					poolKey: 'SUI_USDC',
					accountALabel: 'Account A',
					accountBLabel: 'Account B',
					hasPrivateKeyA: true,
					hasPrivateKeyB: true,
					notionalSizeUsd: 100,
					holdRangeSeconds: [30, 60],
					maxCycles: 10,
					slippageTolerance: 0.5,
					settingsApplyPending: false
				}
			}),
			onOpenSettings: () => {},
			onOpenStart: () => {},
			onClean: () => {},
			settingsPending: false,
			settingsSaving: false,
			controlPending: false,
			preflightPending: false
		});

		expect(screen.getByText('2/10')).toBeTruthy();
		expect(screen.queryByText('276/10')).toBeNull();
	});
});
