// @vitest-environment jsdom
// @vitest-environment-options {"customExportConditions":["browser"]}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';

import type { RuntimeSnapshot } from '$lib/types/bot.js';

const createConfigSummary = (overrides: Partial<NonNullable<RuntimeSnapshot['config']>> = {}) => ({
	network: 'mainnet' as const,
	rpcUrl: 'https://fullnode.mainnet.sui.io:443',
	experimentalDeeptradeLimitPtb: false,
	deeptradeOrderbookApiBase: 'https://api.deeptrade.space/api',
	poolKey: 'SUI_USDC',
	accountALabel: 'Account A',
	accountBLabel: 'Account B',
	hasPrivateKeyA: true,
	hasPrivateKeyB: true,
	notionalSizeUsd: 4,
	holdRangeSeconds: [150, 210] as [number, number],
	maxCycles: 10,
	slippageTolerance: 0.005,
	settingsApplyPending: false,
	updatedAt: new Date(0).toISOString(),
	...overrides
});

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

beforeEach(() => {
	vi.stubGlobal(
		'matchMedia',
		vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn()
		}))
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('HeroMetrics', () => {
	it('sanitizes runtime message and keeps fees/gas hidden by default', async () => {
		const { default: HeroMetrics } = await import('./HeroMetrics.svelte');
		render(HeroMetrics, {
			snapshot: createSnapshot({
				message: 'Deepbook ready.'
			}),
			accountALabel: 'Account A',
			accountBLabel: 'Account B',
			activeCycleLabel: 'Awaiting next cycle',
			activeCycleProgress: 0,
			startPending: false,
			streamError: false,
			priceRingCircumference: 100,
			priceRingOffset: 100
		});

		expect(screen.getByText('runtime ready.')).toBeTruthy();
		expect(screen.getByText('Fees: •••• · Gas: ••••')).toBeTruthy();
	});

	it('shows reconnecting warning while stream has an error', async () => {
		const { default: HeroMetrics } = await import('./HeroMetrics.svelte');
		render(HeroMetrics, {
			snapshot: createSnapshot(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B',
			activeCycleLabel: 'Awaiting next cycle',
			activeCycleProgress: 0,
			startPending: false,
			streamError: true,
			priceRingCircumference: 100,
			priceRingOffset: 100
		});

		expect(screen.getByText('Realtime stream reconnecting...')).toBeTruthy();
	});

	it('shows collecting ticks placeholder until enough live points are available', async () => {
		const { default: HeroMetrics } = await import('./HeroMetrics.svelte');
		render(HeroMetrics, {
			snapshot: createSnapshot(),
			accountALabel: 'Account A',
			accountBLabel: 'Account B',
			activeCycleLabel: 'Awaiting next cycle',
			activeCycleProgress: 0,
			startPending: false,
			streamError: false,
			priceRingCircumference: 100,
			priceRingOffset: 100
		});

		expect(screen.getByText('Collecting live ticks...')).toBeTruthy();
	});
});
