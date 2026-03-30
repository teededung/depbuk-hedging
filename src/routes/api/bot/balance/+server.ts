import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const POST: RequestHandler = async ({ request }) => {
	const runtime = getBotRuntime();
	const payload = (await request.json()) as { action?: string; targetCycles?: number };
	const targetCycles = Math.max(1, Math.min(payload.targetCycles ?? 2, 20));

	try {
		const snapshot = runtime.getSnapshot();
		const forceBoot =
			snapshot.config?.settingsApplyPending &&
			snapshot.lifecycle !== 'RUNNING' &&
			snapshot.lifecycle !== 'STOPPING';
		await runtime.ensureBooted(forceBoot);

		if (payload.action === 'preview') {
			const preview = await runtime.previewAutoBalance(targetCycles);
			return json({ preview, snapshot: runtime.getSnapshot() });
		}

		if (payload.action === 'execute') {
			const snapshot = await runtime.runAutoBalance(targetCycles);
			return json({ snapshot });
		}

		return json(
			{ error: 'Unsupported balance action. Use "preview" or "execute".' },
			{ status: 400 }
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Auto-balance failed.';
		return json({ error: message, snapshot: runtime.getSnapshot() }, { status: 500 });
	}
};
