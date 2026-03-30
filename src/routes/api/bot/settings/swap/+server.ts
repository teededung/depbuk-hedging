import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const POST: RequestHandler = async () => {
	try {
		const runtime = getBotRuntime();
		await runtime.swapAccounts();
		return json({ snapshot: runtime.getSnapshot() });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to swap accounts.';
		return json({ error: message }, { status: 500 });
	}
};
