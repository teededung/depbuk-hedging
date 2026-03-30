import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutoBalancePreview } from '../../../../lib/server/bot/types.js';
import { createSnapshot } from '../../../../lib/server/bot/runtime-snapshot.js';

const routeRuntimeState = vi.hoisted(() => ({
	runtime: null as {
		ensureBooted: ReturnType<typeof vi.fn>;
		previewAutoBalance: ReturnType<typeof vi.fn>;
		runAutoBalance: ReturnType<typeof vi.fn>;
		getSnapshot: ReturnType<typeof vi.fn>;
	} | null
}));

vi.mock('$lib/server/bot/runtime.js', () => ({
	getBotRuntime: () => routeRuntimeState.runtime
}));

import { POST } from './+server.js';

function createFakePreview(): AutoBalancePreview {
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

function createFakeRuntime(
	overrides: {
		previewResult?: AutoBalancePreview;
		executeResult?: ReturnType<typeof createSnapshot>;
		executeError?: Error;
	} = {}
) {
	const snapshot = createSnapshot();
	return {
		ensureBooted: vi.fn().mockResolvedValue(undefined),
		previewAutoBalance: vi.fn().mockResolvedValue(overrides.previewResult ?? createFakePreview()),
		runAutoBalance: overrides.executeError
			? vi.fn().mockRejectedValue(overrides.executeError)
			: vi.fn().mockResolvedValue(overrides.executeResult ?? snapshot),
		getSnapshot: vi.fn().mockReturnValue(snapshot)
	};
}

async function postJson(payload: Record<string, unknown>) {
	return POST({
		request: new Request('http://localhost/api/bot/balance', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		})
	} as never);
}

describe('/api/bot/balance route', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		routeRuntimeState.runtime = createFakeRuntime();
	});

	it('preview returns preview + snapshot', async () => {
		const response = await postJson({ action: 'preview', targetCycles: 3 });
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.preview).toBeDefined();
		expect(body.snapshot).toBeDefined();
		expect(routeRuntimeState.runtime!.ensureBooted).toHaveBeenCalledTimes(1);
		expect(routeRuntimeState.runtime!.previewAutoBalance).toHaveBeenCalledWith(3);
	});

	it('execute returns snapshot', async () => {
		const response = await postJson({ action: 'execute', targetCycles: 5 });
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.snapshot).toBeDefined();
		expect(body.preview).toBeUndefined();
		expect(routeRuntimeState.runtime!.ensureBooted).toHaveBeenCalledTimes(1);
		expect(routeRuntimeState.runtime!.runAutoBalance).toHaveBeenCalledWith(5);
	});

	it('unsupported action returns 400', async () => {
		const response = await postJson({ action: 'reset' });
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toContain('Unsupported');
		expect(routeRuntimeState.runtime!.previewAutoBalance).not.toHaveBeenCalled();
		expect(routeRuntimeState.runtime!.runAutoBalance).not.toHaveBeenCalled();
	});

	it('thrown runtime error returns 500 with snapshot', async () => {
		routeRuntimeState.runtime = createFakeRuntime({
			executeError: new Error('RPC timeout')
		});

		const response = await postJson({ action: 'execute', targetCycles: 2 });
		const body = await response.json();

		expect(response.status).toBe(500);
		expect(body.error).toBe('RPC timeout');
		expect(body.snapshot).toBeDefined();
	});
});
