import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const GET: RequestHandler = async () => {
	try {
		const runtime = getBotRuntime();
		const preview = await runtime.previewNotionalMax();
		return json({ preview });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to estimate max notional.';
		return json({ error: message }, { status: 500 });
	}
};
