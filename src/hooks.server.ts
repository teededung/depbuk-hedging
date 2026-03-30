import type { Handle } from '@sveltejs/kit';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	return response;
};

export async function handleClose(): Promise<void> {
	await getBotRuntime().shutdown();
}
