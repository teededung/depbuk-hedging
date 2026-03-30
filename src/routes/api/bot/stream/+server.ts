import type { RequestHandler } from './$types.js';

import { getBotRuntime } from '$lib/server/bot/runtime.js';

export const GET: RequestHandler = async () => {
	const runtime = getBotRuntime();
	await runtime.ensureBooted();
	let unsubscribe: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (payload: unknown) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
			};

			send(runtime.getSnapshot());
			unsubscribe = runtime.subscribe((snapshot) => send(snapshot));
		},
		cancel() {
			unsubscribe?.();
			unsubscribe = null;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
};
