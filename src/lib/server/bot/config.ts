import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { BOT_SETTINGS_DEFAULTS as SHARED_BOT_SETTINGS_DEFAULTS } from '$lib/bot-settings-defaults.js';

import type {
	BotConfig,
	BotConfigSummary,
	BotOrderExecutionMode,
	BotSettingsUpdateInput,
	BotSettingsView
} from './types.js';

export type BotSettingsRow = {
	settings_key: 'global';
	network: BotConfig['network'];
	rpc_url: string;
	experimental_deeptrade_limit_ptb: boolean;
	deeptrade_orderbook_api_base: string;
	pool_key: string;
	account_a_label: string;
	account_b_label: string;
	private_key_a_encrypted: string | null;
	private_key_b_encrypted: string | null;
	notional_size_usd: number;
	min_hold_seconds: number;
	max_hold_seconds: number;
	max_cycles: number | null;
	slippage_tolerance: number;
	random_size_bps: number;
	min_order_delay_ms: number;
	max_order_delay_ms: number;
	open_order_execution_mode: BotOrderExecutionMode;
	close_order_execution_mode: BotOrderExecutionMode;
	auto_swap_enabled: boolean;
	auto_swap_buffer_bps: number;
	min_gas_reserve_sui: number;
	order_poll_interval_ms: number;
	maker_reprice_seconds: number;
	force_market_close_seconds: number;
	account_a_margin_manager_id: string | null;
	account_b_margin_manager_id: string | null;
	account_a_borrow_quote_factor: number;
	account_b_borrow_base_factor: number;
	notional_auto_reduce_floor_pct: number;
	created_at: Date;
	updated_at: Date;
};

type SecretPayload = {
	v: 1;
	iv: string;
	tag: string;
	data: string;
};

export const BOT_SETTINGS_KEY = 'global' as const;

export const BOT_SETTINGS_DEFAULTS: BotSettingsUpdateInput = SHARED_BOT_SETTINGS_DEFAULTS;

function ensureNumber(name: string, value: unknown): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid numeric config value for ${name}`);
	}
	return parsed;
}

function ensureString(name: string, value: unknown, required = true): string | undefined {
	if (value == null || value === '') {
		if (required) {
			throw new Error(`Missing config value for ${name}`);
		}
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new Error(`Invalid string config value for ${name}`);
	}
	return value.trim();
}

function ensureBoolean(name: string, value: unknown): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'true') return true;
		if (normalized === 'false') return false;
	}
	throw new Error(`Invalid boolean config value for ${name}`);
}

function ensureOrderExecutionMode(name: string, value: unknown): BotOrderExecutionMode {
	if (value === 'limit' || value === 'market') {
		return value;
	}
	throw new Error(`${name} must be either limit or market`);
}

function parseRpcUrlList(name: string, value: string): string[] {
	const urls = [
		...new Set(
			value
				.split(/[\n,]+/)
				.map((item) => item.trim())
				.filter(Boolean)
		)
	];
	if (urls.length === 0) {
		throw new Error(`Missing config value for ${name}`);
	}

	for (const url of urls) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`Invalid URL in ${name}: ${url}`);
		}

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(`Invalid URL in ${name}: ${url}`);
		}
	}

	return urls;
}

function serializeRpcUrlList(urls: string[]): string {
	return urls.join('\n');
}

function nullableString(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function settingsEncryptionKey(): Buffer {
	const secret = (env.BOT_SETTINGS_MASTER_KEY ?? process.env.BOT_SETTINGS_MASTER_KEY)?.trim();
	if (!secret) {
		throw new Error('BOT_SETTINGS_MASTER_KEY is required to encrypt or decrypt private keys');
	}
	return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
	const key = settingsEncryptionKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const payload: SecretPayload = {
		v: 1,
		iv: iv.toString('base64'),
		tag: tag.toString('base64'),
		data: data.toString('base64')
	};
	return JSON.stringify(payload);
}

export function decryptSecret(serialized: string): string {
	const payload = JSON.parse(serialized) as SecretPayload;
	if (payload.v !== 1) {
		throw new Error('Unsupported encrypted secret payload version');
	}
	const key = settingsEncryptionKey();
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
	decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(payload.data, 'base64')),
		decipher.final()
	]);
	return plaintext.toString('utf8');
}

export function buildDefaultSettingsRow(): Omit<
	BotSettingsRow,
	'private_key_a_encrypted' | 'private_key_b_encrypted' | 'created_at' | 'updated_at'
> {
	return {
		settings_key: BOT_SETTINGS_KEY,
		network: BOT_SETTINGS_DEFAULTS.network,
		rpc_url: BOT_SETTINGS_DEFAULTS.rpc_url,
		experimental_deeptrade_limit_ptb: BOT_SETTINGS_DEFAULTS.experimental_deeptrade_limit_ptb,
		deeptrade_orderbook_api_base: BOT_SETTINGS_DEFAULTS.deeptrade_orderbook_api_base,
		pool_key: BOT_SETTINGS_DEFAULTS.pool_key,
		account_a_label: BOT_SETTINGS_DEFAULTS.account_a_label,
		account_b_label: BOT_SETTINGS_DEFAULTS.account_b_label,
		notional_size_usd: BOT_SETTINGS_DEFAULTS.notional_size_usd,
		min_hold_seconds: BOT_SETTINGS_DEFAULTS.min_hold_seconds,
		max_hold_seconds: BOT_SETTINGS_DEFAULTS.max_hold_seconds,
		max_cycles: BOT_SETTINGS_DEFAULTS.max_cycles,
		slippage_tolerance: BOT_SETTINGS_DEFAULTS.slippage_tolerance,
		random_size_bps: BOT_SETTINGS_DEFAULTS.random_size_bps,
		min_order_delay_ms: BOT_SETTINGS_DEFAULTS.min_order_delay_ms,
		max_order_delay_ms: BOT_SETTINGS_DEFAULTS.max_order_delay_ms,
		open_order_execution_mode: BOT_SETTINGS_DEFAULTS.open_order_execution_mode,
		close_order_execution_mode: BOT_SETTINGS_DEFAULTS.close_order_execution_mode,
		auto_swap_enabled: BOT_SETTINGS_DEFAULTS.auto_swap_enabled,
		auto_swap_buffer_bps: BOT_SETTINGS_DEFAULTS.auto_swap_buffer_bps,
		min_gas_reserve_sui: BOT_SETTINGS_DEFAULTS.min_gas_reserve_sui,
		order_poll_interval_ms: BOT_SETTINGS_DEFAULTS.order_poll_interval_ms,
		maker_reprice_seconds: BOT_SETTINGS_DEFAULTS.maker_reprice_seconds,
		force_market_close_seconds: BOT_SETTINGS_DEFAULTS.force_market_close_seconds,
		account_a_margin_manager_id: BOT_SETTINGS_DEFAULTS.account_a_margin_manager_id ?? null,
		account_b_margin_manager_id: BOT_SETTINGS_DEFAULTS.account_b_margin_manager_id ?? null,
		account_a_borrow_quote_factor: BOT_SETTINGS_DEFAULTS.account_a_borrow_quote_factor,
		account_b_borrow_base_factor: BOT_SETTINGS_DEFAULTS.account_b_borrow_base_factor,
		notional_auto_reduce_floor_pct: BOT_SETTINGS_DEFAULTS.notional_auto_reduce_floor_pct
	};
}

export function sanitizeSettings(row: BotSettingsRow): BotSettingsView {
	return {
		network: row.network,
		rpc_url: row.rpc_url,
		experimental_deeptrade_limit_ptb: row.experimental_deeptrade_limit_ptb,
		deeptrade_orderbook_api_base: row.deeptrade_orderbook_api_base,
		pool_key: row.pool_key,
		account_a_label: row.account_a_label,
		account_b_label: row.account_b_label,
		notional_size_usd: row.notional_size_usd,
		min_hold_seconds: row.min_hold_seconds,
		max_hold_seconds: row.max_hold_seconds,
		max_cycles: row.max_cycles,
		slippage_tolerance: row.slippage_tolerance,
		random_size_bps: row.random_size_bps,
		min_order_delay_ms: row.min_order_delay_ms,
		max_order_delay_ms: row.max_order_delay_ms,
		open_order_execution_mode: row.open_order_execution_mode,
		close_order_execution_mode: row.close_order_execution_mode,
		auto_swap_enabled: row.auto_swap_enabled,
		auto_swap_buffer_bps: row.auto_swap_buffer_bps,
		min_gas_reserve_sui: row.min_gas_reserve_sui,
		order_poll_interval_ms: row.order_poll_interval_ms,
		maker_reprice_seconds: row.maker_reprice_seconds,
		force_market_close_seconds: row.force_market_close_seconds,
		account_a_margin_manager_id: row.account_a_margin_manager_id ?? undefined,
		account_b_margin_manager_id: row.account_b_margin_manager_id ?? undefined,
		account_a_borrow_quote_factor: row.account_a_borrow_quote_factor,
		account_b_borrow_base_factor: row.account_b_borrow_base_factor,
		notional_auto_reduce_floor_pct: row.notional_auto_reduce_floor_pct,
		has_private_key_a: Boolean(row.private_key_a_encrypted),
		has_private_key_b: Boolean(row.private_key_b_encrypted),
		updated_at: row.updated_at.toISOString()
	};
}

export function validateSettingsInput(
	raw: Record<string, unknown>,
	existing?: BotSettingsView
): BotSettingsUpdateInput {
	const rpcUrls = parseRpcUrlList(
		'rpc_url',
		ensureString('rpc_url', raw.rpc_url ?? BOT_SETTINGS_DEFAULTS.rpc_url)!
	);
	const minHold = ensureNumber('min_hold_seconds', raw.min_hold_seconds);
	const maxHold = ensureNumber('max_hold_seconds', raw.max_hold_seconds);
	if (minHold <= 0 || maxHold <= 0 || minHold > maxHold) {
		throw new Error('Hold seconds range is invalid');
	}

	const notional = ensureNumber('notional_size_usd', raw.notional_size_usd);
	if (notional <= 0) {
		throw new Error('notional_size_usd must be > 0');
	}

	const slippage = ensureNumber('slippage_tolerance', raw.slippage_tolerance);
	if (slippage < 0.001 || slippage > 0.1) {
		throw new Error('slippage_tolerance must be between 0.001 and 0.1');
	}

	const maxCyclesRaw = raw.max_cycles;
	const maxCycles =
		maxCyclesRaw == null || maxCyclesRaw === '' ? null : ensureNumber('max_cycles', maxCyclesRaw);

	const network = (raw.network ?? BOT_SETTINGS_DEFAULTS.network) as BotConfig['network'];
	if (network !== 'mainnet' && network !== 'testnet') {
		throw new Error('network must be either mainnet or testnet');
	}

	const privateKeyA = ensureString('private_key_A', raw.private_key_A, false);
	const privateKeyB = ensureString('private_key_B', raw.private_key_B, false);
	if (!privateKeyA && !existing?.has_private_key_a) {
		throw new Error('Missing config value for private_key_A');
	}
	if (!privateKeyB && !existing?.has_private_key_b) {
		throw new Error('Missing config value for private_key_B');
	}

	return {
		network,
		rpc_url: serializeRpcUrlList(rpcUrls),
		experimental_deeptrade_limit_ptb: ensureBoolean(
			'experimental_deeptrade_limit_ptb',
			raw.experimental_deeptrade_limit_ptb ?? BOT_SETTINGS_DEFAULTS.experimental_deeptrade_limit_ptb
		),
		deeptrade_orderbook_api_base: ensureString(
			'deeptrade_orderbook_api_base',
			raw.deeptrade_orderbook_api_base ?? BOT_SETTINGS_DEFAULTS.deeptrade_orderbook_api_base
		)!,
		pool_key: ensureString('pool_key', raw.pool_key ?? BOT_SETTINGS_DEFAULTS.pool_key)!,
		account_a_label: ensureString(
			'account_a_label',
			raw.account_a_label ?? BOT_SETTINGS_DEFAULTS.account_a_label
		)!,
		account_b_label: ensureString(
			'account_b_label',
			raw.account_b_label ?? BOT_SETTINGS_DEFAULTS.account_b_label
		)!,
		private_key_A: privateKeyA,
		private_key_B: privateKeyB,
		notional_size_usd: notional,
		min_hold_seconds: minHold,
		max_hold_seconds: maxHold,
		max_cycles: maxCycles,
		slippage_tolerance: slippage,
		order_poll_interval_ms: ensureNumber(
			'order_poll_interval_ms',
			raw.order_poll_interval_ms ?? BOT_SETTINGS_DEFAULTS.order_poll_interval_ms
		),
		maker_reprice_seconds: ensureNumber(
			'maker_reprice_seconds',
			raw.maker_reprice_seconds ?? BOT_SETTINGS_DEFAULTS.maker_reprice_seconds
		),
		force_market_close_seconds: ensureNumber(
			'force_market_close_seconds',
			raw.force_market_close_seconds ?? BOT_SETTINGS_DEFAULTS.force_market_close_seconds
		),
		random_size_bps: ensureNumber(
			'random_size_bps',
			raw.random_size_bps ?? BOT_SETTINGS_DEFAULTS.random_size_bps
		),
		open_order_execution_mode: ensureOrderExecutionMode(
			'open_order_execution_mode',
			raw.open_order_execution_mode ?? BOT_SETTINGS_DEFAULTS.open_order_execution_mode
		),
		close_order_execution_mode: ensureOrderExecutionMode(
			'close_order_execution_mode',
			raw.close_order_execution_mode ?? BOT_SETTINGS_DEFAULTS.close_order_execution_mode
		),
		auto_swap_enabled: ensureBoolean(
			'auto_swap_enabled',
			raw.auto_swap_enabled ?? BOT_SETTINGS_DEFAULTS.auto_swap_enabled
		),
		auto_swap_buffer_bps: ensureNumber(
			'auto_swap_buffer_bps',
			raw.auto_swap_buffer_bps ?? BOT_SETTINGS_DEFAULTS.auto_swap_buffer_bps
		),
		min_gas_reserve_sui: ensureNumber(
			'min_gas_reserve_sui',
			raw.min_gas_reserve_sui ?? BOT_SETTINGS_DEFAULTS.min_gas_reserve_sui
		),
		min_order_delay_ms: ensureNumber(
			'min_order_delay_ms',
			raw.min_order_delay_ms ?? BOT_SETTINGS_DEFAULTS.min_order_delay_ms
		),
		max_order_delay_ms: ensureNumber(
			'max_order_delay_ms',
			raw.max_order_delay_ms ?? BOT_SETTINGS_DEFAULTS.max_order_delay_ms
		),
		account_a_margin_manager_id: nullableString(
			ensureString('account_a_margin_manager_id', raw.account_a_margin_manager_id, false)
		),
		account_b_margin_manager_id: nullableString(
			ensureString('account_b_margin_manager_id', raw.account_b_margin_manager_id, false)
		),
		account_a_borrow_quote_factor: ensureNumber(
			'account_a_borrow_quote_factor',
			raw.account_a_borrow_quote_factor ?? BOT_SETTINGS_DEFAULTS.account_a_borrow_quote_factor
		),
		account_b_borrow_base_factor: ensureNumber(
			'account_b_borrow_base_factor',
			raw.account_b_borrow_base_factor ?? BOT_SETTINGS_DEFAULTS.account_b_borrow_base_factor
		),
		notional_auto_reduce_floor_pct: Math.max(
			1,
			Math.min(
				100,
				Math.round(
					ensureNumber(
						'notional_auto_reduce_floor_pct',
						raw.notional_auto_reduce_floor_pct ??
							BOT_SETTINGS_DEFAULTS.notional_auto_reduce_floor_pct
					)
				)
			)
		)
	};
}

export function toBotConfig(row: BotSettingsRow): BotConfig {
	const privateKeyA = row.private_key_a_encrypted ? decryptSecret(row.private_key_a_encrypted) : '';
	const privateKeyB = row.private_key_b_encrypted ? decryptSecret(row.private_key_b_encrypted) : '';
	const config = validateSettingsInput(
		{
			...sanitizeSettings(row),
			private_key_A: privateKeyA,
			private_key_B: privateKeyB
		},
		{
			...sanitizeSettings(row),
			has_private_key_a: Boolean(privateKeyA),
			has_private_key_b: Boolean(privateKeyB)
		}
	);
	const rpcUrls = parseRpcUrlList('rpc_url', config.rpc_url);

	return {
		network: config.network,
		rpc_url: rpcUrls[0]!,
		rpc_urls: rpcUrls,
		experimental_deeptrade_limit_ptb: config.experimental_deeptrade_limit_ptb,
		deeptrade_orderbook_api_base: config.deeptrade_orderbook_api_base,
		pool_key: config.pool_key,
		account_a_label: config.account_a_label,
		account_b_label: config.account_b_label,
		private_key_A: privateKeyA,
		private_key_B: privateKeyB,
		notional_size_usd: config.notional_size_usd,
		min_hold_seconds: config.min_hold_seconds,
		max_hold_seconds: config.max_hold_seconds,
		max_cycles: config.max_cycles,
		slippage_tolerance: config.slippage_tolerance,
		order_poll_interval_ms: config.order_poll_interval_ms,
		maker_reprice_seconds: config.maker_reprice_seconds,
		force_market_close_seconds: config.force_market_close_seconds,
		random_size_bps: config.random_size_bps,
		min_order_delay_ms: config.min_order_delay_ms,
		max_order_delay_ms: config.max_order_delay_ms,
		open_order_execution_mode: config.open_order_execution_mode,
		close_order_execution_mode: config.close_order_execution_mode,
		auto_swap_enabled: config.auto_swap_enabled,
		auto_swap_buffer_bps: config.auto_swap_buffer_bps,
		min_gas_reserve_sui: config.min_gas_reserve_sui,
		account_a_margin_manager_id: config.account_a_margin_manager_id,
		account_b_margin_manager_id: config.account_b_margin_manager_id,
		account_a_borrow_quote_factor: config.account_a_borrow_quote_factor,
		account_b_borrow_base_factor: config.account_b_borrow_base_factor,
		notional_auto_reduce_floor_pct: config.notional_auto_reduce_floor_pct
	};
}

export function toReadOnlyBotConfig(
	configOrSettings: Pick<
		BotSettingsRow,
		| 'network'
		| 'rpc_url'
		| 'experimental_deeptrade_limit_ptb'
		| 'deeptrade_orderbook_api_base'
		| 'pool_key'
		| 'account_a_label'
		| 'account_b_label'
		| 'notional_size_usd'
		| 'min_hold_seconds'
		| 'max_hold_seconds'
		| 'max_cycles'
		| 'slippage_tolerance'
		| 'order_poll_interval_ms'
		| 'maker_reprice_seconds'
		| 'force_market_close_seconds'
		| 'random_size_bps'
		| 'min_order_delay_ms'
		| 'max_order_delay_ms'
		| 'open_order_execution_mode'
		| 'close_order_execution_mode'
		| 'auto_swap_enabled'
		| 'auto_swap_buffer_bps'
		| 'min_gas_reserve_sui'
		| 'account_a_margin_manager_id'
		| 'account_b_margin_manager_id'
		| 'account_a_borrow_quote_factor'
		| 'account_b_borrow_base_factor'
		| 'notional_auto_reduce_floor_pct'
	>
): BotConfig {
	const rpcUrls = parseRpcUrlList('rpc_url', configOrSettings.rpc_url);

	return {
		network: configOrSettings.network,
		rpc_url: rpcUrls[0]!,
		rpc_urls: rpcUrls,
		experimental_deeptrade_limit_ptb: configOrSettings.experimental_deeptrade_limit_ptb,
		deeptrade_orderbook_api_base: configOrSettings.deeptrade_orderbook_api_base,
		pool_key: configOrSettings.pool_key,
		account_a_label: configOrSettings.account_a_label,
		account_b_label: configOrSettings.account_b_label,
		private_key_A: '',
		private_key_B: '',
		notional_size_usd: configOrSettings.notional_size_usd,
		min_hold_seconds: configOrSettings.min_hold_seconds,
		max_hold_seconds: configOrSettings.max_hold_seconds,
		max_cycles: configOrSettings.max_cycles,
		slippage_tolerance: configOrSettings.slippage_tolerance,
		order_poll_interval_ms: configOrSettings.order_poll_interval_ms,
		maker_reprice_seconds: configOrSettings.maker_reprice_seconds,
		force_market_close_seconds: configOrSettings.force_market_close_seconds,
		random_size_bps: configOrSettings.random_size_bps,
		min_order_delay_ms: configOrSettings.min_order_delay_ms,
		max_order_delay_ms: configOrSettings.max_order_delay_ms,
		open_order_execution_mode: configOrSettings.open_order_execution_mode,
		close_order_execution_mode: configOrSettings.close_order_execution_mode,
		auto_swap_enabled: configOrSettings.auto_swap_enabled,
		auto_swap_buffer_bps: configOrSettings.auto_swap_buffer_bps,
		min_gas_reserve_sui: configOrSettings.min_gas_reserve_sui,
		account_a_margin_manager_id: configOrSettings.account_a_margin_manager_id ?? undefined,
		account_b_margin_manager_id: configOrSettings.account_b_margin_manager_id ?? undefined,
		account_a_borrow_quote_factor: configOrSettings.account_a_borrow_quote_factor,
		account_b_borrow_base_factor: configOrSettings.account_b_borrow_base_factor,
		notional_auto_reduce_floor_pct: configOrSettings.notional_auto_reduce_floor_pct
	};
}

export function toConfigSummary(
	configOrSettings: BotConfig | BotSettingsView | null,
	options?: { settingsApplyPending?: boolean }
): BotConfigSummary | null {
	if (!configOrSettings) {
		return null;
	}

	const fromSettings = 'has_private_key_a' in configOrSettings;
	const rpcUrls =
		'rpc_urls' in configOrSettings
			? configOrSettings.rpc_urls
			: parseRpcUrlList('rpc_url', configOrSettings.rpc_url);
	const experimentalDeeptradeLimitPtb =
		'experimental_deeptrade_limit_ptb' in configOrSettings
			? configOrSettings.experimental_deeptrade_limit_ptb
			: false;
	return {
		network: configOrSettings.network,
		rpcUrl: rpcUrls[0] ?? configOrSettings.rpc_url,
		experimentalDeeptradeLimitPtb,
		deeptradeOrderbookApiBase: configOrSettings.deeptrade_orderbook_api_base,
		poolKey: configOrSettings.pool_key,
		accountALabel: configOrSettings.account_a_label,
		accountBLabel: configOrSettings.account_b_label,
		hasPrivateKeyA: fromSettings ? configOrSettings.has_private_key_a : true,
		hasPrivateKeyB: fromSettings ? configOrSettings.has_private_key_b : true,
		notionalSizeUsd: configOrSettings.notional_size_usd,
		holdRangeSeconds: [configOrSettings.min_hold_seconds, configOrSettings.max_hold_seconds],
		maxCycles: configOrSettings.max_cycles,
		slippageTolerance: configOrSettings.slippage_tolerance,
		settingsApplyPending: options?.settingsApplyPending ?? false,
		updatedAt: fromSettings ? configOrSettings.updated_at : undefined
	};
}
