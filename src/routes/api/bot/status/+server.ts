import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const GET: RequestHandler = async ({ url }) => {
	const runtime = getBotRuntime();
	if (url.searchParams.get('readiness') === 'start') {
		await runtime.refreshStartReadiness();
	} else {
		await runtime.ensureBooted();
	}
	return json(runtime.getSnapshot());
};
