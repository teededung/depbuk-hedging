import type { PageServerLoad } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const load: PageServerLoad = async () => {
	const runtime = getBotRuntime();
	await runtime.ensureBooted();

	return {
		snapshot: runtime.getSnapshot()
	};
};
