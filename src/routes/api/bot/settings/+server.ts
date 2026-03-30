import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const GET: RequestHandler = async () => {
	try {
		const runtime = getBotRuntime();
		const settings = await runtime.getSettings();
		return json({ settings, snapshot: runtime.getSnapshot() });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to load bot settings.';
		return json({ error: message }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const runtime = getBotRuntime();
		const payload = (await request.json()) as Record<string, unknown>;
		await runtime.saveSettings(payload);
		const settings = await runtime.getSettings();
		return json({ settings, snapshot: runtime.getSnapshot() });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to save bot settings.';
		return json({ error: message }, { status: 500 });
	}
};
