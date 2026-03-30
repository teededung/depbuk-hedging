import type { RuntimeSnapshot } from '$lib/types/bot.js';

const DEFAULT_UPDATED_AT = new Date(0).toISOString();

function createEmptyStats(updatedAt: string): RuntimeSnapshot['stats'] {
	return {
		totalVolumeAllTime: 0,
		totalVolumeToday: 0,
		totalVolumeAccountA: 0,
		totalVolumeAccountB: 0,
		sessionPnl: 0,
		sessionFees: 0,
		sessionGas: 0,
		cyclesCompleted: 0,
		updatedAt
	};
}

function createEmptyPrice(updatedAt: string): RuntimeSnapshot['price'] {
	return {
		source: 'static',
		price: 0,
		updatedAt,
		uptimeSeconds: 0
	};
}

export function createEmptyBalances(updatedAt = DEFAULT_UPDATED_AT): RuntimeSnapshot['balances'] {
	return {
		source: 'static',
		accountA: {
			sui: 0,
			usdc: 0,
			totalUsdc: 0,
			updatedAt
		},
		accountB: {
			sui: 0,
			usdc: 0,
			totalUsdc: 0,
			updatedAt
		},
		totalUsdc: 0,
		updatedAt
	};
}

export function createEmptyPreflightAccount(
	account: 'accountA' | 'accountB',
	label: string,
	requiredAsset: 'SUI' | 'USDC',
	updatedAt: string
): RuntimeSnapshot['preflight']['accountA'] {
	return {
		account,
		label,
		requiredAsset,
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
		updatedAt
	};
}

export function createEmptyPreflight(updatedAt = DEFAULT_UPDATED_AT): RuntimeSnapshot['preflight'] {
	return {
		state: 'config-required',
		ready: false,
		referencePrice: 0,
		plannedNotionalUsd: 0,
		estimatedQuantitySui: 0,
		configuredNotionalUsd: 0,
		minNotionalUsd: 0,
		effectiveNotionalUsd: 0,
		autoReduced: false,
		accountA: createEmptyPreflightAccount('accountA', 'Account A (Long)', 'SUI', updatedAt),
		accountB: createEmptyPreflightAccount('accountB', 'Account B (Short)', 'USDC', updatedAt),
		updatedAt
	};
}

export function createEmptyAutoTopup(updatedAt = DEFAULT_UPDATED_AT): RuntimeSnapshot['autoTopup'] {
	return {
		status: 'idle',
		account: null,
		updatedAt
	};
}

export function createSnapshotDefaults(updatedAt: string = DEFAULT_UPDATED_AT): Omit<
	RuntimeSnapshot,
	'message'
> {
	return {
		lifecycle: 'BOOTING',
		liveLabel: 'Offline',
		runLabel: 'BOOTING',
		runCycleCount: 0,
		stats: createEmptyStats(updatedAt),
		price: createEmptyPrice(updatedAt),
		balances: createEmptyBalances(updatedAt),
		preflight: createEmptyPreflight(updatedAt),
		autoTopup: createEmptyAutoTopup(updatedAt),
		activeCycle: null,
		history: [],
		logs: [],
		config: null,
		updatedAt
	};
}
