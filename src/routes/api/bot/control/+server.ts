import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const POST: RequestHandler = async ({ request }) => {
	const runtime = getBotRuntime();
	const payload = (await request.json()) as { action?: string };

	if (payload.action === 'stop-clean') {
		await runtime.stopAndClean();
		return json(runtime.getSnapshot());
	}

	if (payload.action === 'stop') {
		await runtime.stop();
		return json(runtime.getSnapshot());
	}

	if (payload.action === 'start') {
		await runtime.start();
		return json(runtime.getSnapshot());
	}

	return json({ error: 'Unsupported bot action' }, { status: 400 });
};
