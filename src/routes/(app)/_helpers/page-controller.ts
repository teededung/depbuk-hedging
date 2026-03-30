import type { BotSettingsView, RuntimeSnapshot } from '$lib/types/bot.js';

import type { SettingsForm } from './page-view.js';

export type SettingsPayload = {
	settings: BotSettingsView;
	snapshot: RuntimeSnapshot;
};

type SettingsErrorPayload = {
	error?: string;
};

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

export async function fetchBotControl(action: 'start' | 'stop' | 'stop-clean'): Promise<RuntimeSnapshot> {
	const response = await fetch('/api/bot/control', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action })
	});
	if (!response.ok) {
		throw new Error(`Bot control failed (${response.status})`);
	}
	return readJson<RuntimeSnapshot>(response);
}

export async function fetchBotStatus(readiness = false): Promise<RuntimeSnapshot> {
	const response = await fetch(readiness ? '/api/bot/status?readiness=start' : '/api/bot/status');
	if (!response.ok) {
		throw new Error(`Failed to refresh bot status (${response.status})`);
	}
	return readJson<RuntimeSnapshot>(response);
}

export async function fetchBotSettings(): Promise<SettingsPayload> {
	const response = await fetch('/api/bot/settings');
	if (!response.ok) {
		throw new Error(`Failed to load settings (${response.status})`);
	}
	return readJson<SettingsPayload>(response);
}

export async function saveBotSettings(settingsForm: SettingsForm): Promise<SettingsPayload> {
	const response = await fetch('/api/bot/settings', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			...settingsForm,
			private_key_A: settingsForm.private_key_A.trim(),
			private_key_B: settingsForm.private_key_B.trim()
		})
	});

	let payload: SettingsPayload | SettingsErrorPayload | null = null;
	try {
		payload = (await response.json()) as SettingsPayload | SettingsErrorPayload;
	} catch {
		payload = null;
	}

	if (!response.ok || !payload || !('settings' in payload)) {
		throw new Error(
			(payload && 'error' in payload && payload.error) || `Failed to save settings (${response.status})`
		);
	}

	return payload;
}

export async function swapBotSettings(): Promise<{ snapshot: RuntimeSnapshot }> {
	const response = await fetch('/api/bot/settings/swap', { method: 'POST' });
	if (!response.ok) {
		throw new Error('Swap failed');
	}
	return readJson<{ snapshot: RuntimeSnapshot }>(response);
}
