import { Pool } from 'pg';

import {
	BOT_SETTINGS_KEY,
	type BotSettingsRow,
	buildDefaultSettingsRow,
	encryptSecret
} from './config.js';
import {
	sumCycleOrderFeesUsd,
	sumCycleOrderGasUsd,
	sumFilledCycleOrderVolumeUsd
} from './runtime-shared.js';
import type { BotLogEntry, CycleHistoryRecord, DashboardStats } from './types.js';

const DEFAULT_DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgresql://localhost:5432/deepbook_hedging';
const DEFAULT_DB_POOL_MAX = Number(process.env.BOT_DB_POOL_MAX ?? 2);

type BotDatabaseGlobal = typeof globalThis & {
	__deepbookBotPgPools?: Map<string, Pool>;
};

function createPool(connectionString: string): Pool {
	return new Pool({
		connectionString,
		max: Number.isFinite(DEFAULT_DB_POOL_MAX) && DEFAULT_DB_POOL_MAX > 0 ? DEFAULT_DB_POOL_MAX : 2,
		idleTimeoutMillis: 10_000,
		connectionTimeoutMillis: 5_000,
		allowExitOnIdle: true
	});
}

function sharedPools(): Map<string, Pool> {
	const globalState = globalThis as BotDatabaseGlobal;
	if (!globalState.__deepbookBotPgPools) {
		globalState.__deepbookBotPgPools = new Map<string, Pool>();
	}
	return globalState.__deepbookBotPgPools;
}

function getSharedPool(connectionString: string): Pool {
	const pools = sharedPools();
	const existing = pools.get(connectionString);
	if (existing) {
		return existing;
	}

	const pool = createPool(connectionString);
	pools.set(connectionString, pool);
	return pool;
}

type CycleRow = {
	id: number;
	cycle_number: number;
	status: CycleHistoryRecord['status'];
	planned_notional_usd: number;
	volume_usd: number;
	fees_usd: number;
	gas_usd: number;
	pnl_usd: number;
	hold_seconds_target: number;
	hold_seconds_actual: number;
	open_price: number;
	close_price: number;
	started_at: Date;
	hold_started_at: Date | null;
	completed_at: Date | null;
	account_a_manager_id: string | null;
	account_b_manager_id: string | null;
	orders: CycleHistoryRecord['orders'];
	note: string | null;
};

export type ManagerCacheStatus = 'unknown' | 'dirty' | 'flat';

type ManagerCacheRow = {
	manager_id: string;
	account_key: string;
	owner_address: string;
	pool_id: string | null;
	balance_manager_id: string | null;
	status: ManagerCacheStatus;
	open_orders_count: number | null;
	base_asset: number | null;
	quote_asset: number | null;
	base_debt: number | null;
	quote_debt: number | null;
	last_verified_at: Date | null;
	last_cleanup_at: Date | null;
	last_cleanup_error: string | null;
	updated_at: Date;
};

type RecoveryEventRow = {
	id: number;
	cleanup_run_id: string;
	account_key: string;
	manager_id: string | null;
	side: 'LONG' | 'SHORT';
	cycle_number: number | null;
	quantity: number;
	entry_price: number;
	exit_price: number;
	pnl_usd: number;
	gas_usd: number;
	tx_digest: string | null;
	note: string | null;
	created_at: Date;
};

export type SaveBotSettingsInput = {
	network: BotSettingsRow['network'];
	rpc_url: string;
	experimental_deeptrade_limit_ptb: boolean;
	deeptrade_orderbook_api_base: string;
	pool_key: string;
	account_a_label: string;
	account_b_label: string;
	private_key_A?: string;
	private_key_B?: string;
	notional_size_usd: number;
	min_hold_seconds: number;
	max_hold_seconds: number;
	max_cycles: number | null;
	slippage_tolerance: number;
	random_size_bps: number;
	min_order_delay_ms: number;
	max_order_delay_ms: number;
	open_order_execution_mode: 'limit' | 'market';
	close_order_execution_mode: 'limit' | 'market';
	auto_swap_enabled: boolean;
	auto_swap_buffer_bps: number;
	min_gas_reserve_sui: number;
	order_poll_interval_ms: number;
	maker_reprice_seconds: number;
	force_market_close_seconds: number;
	account_a_margin_manager_id?: string;
	account_b_margin_manager_id?: string;
	account_a_borrow_quote_factor: number;
	account_b_borrow_base_factor: number;
	notional_auto_reduce_floor_pct: number;
};

export type ManagerCacheRecord = {
	managerId: string;
	accountKey: string;
	ownerAddress: string;
	poolId?: string;
	balanceManagerId?: string;
	status: ManagerCacheStatus;
	openOrdersCount: number;
	baseAsset: number;
	quoteAsset: number;
	baseDebt: number;
	quoteDebt: number;
	lastVerifiedAt?: string;
	lastCleanupAt?: string;
	lastCleanupError?: string;
	updatedAt: string;
};

export type ManagerCacheUpsert = {
	managerId: string;
	accountKey: string;
	ownerAddress: string;
	poolId?: string;
	balanceManagerId?: string;
	status: ManagerCacheStatus;
	openOrdersCount?: number;
	baseAsset?: number;
	quoteAsset?: number;
	baseDebt?: number;
	quoteDebt?: number;
	lastVerifiedAt?: string;
	lastCleanupAt?: string;
	lastCleanupError?: string | null;
};

export class BotDatabase {
	#pool: Pool;
	#connectionString: string;
	#recoveryEventsTableReady = false;

	constructor(connectionString: string = DEFAULT_DATABASE_URL) {
		this.#connectionString = connectionString;
		this.#pool = getSharedPool(connectionString);
	}

	async init(): Promise<void> {
		try {
			await this.#pool.query('SELECT 1');
		} catch (error) {
			if (error instanceof Error && error.message.includes('does not exist')) {
				await this.#ensureDatabaseExists();
				this.#pool = getSharedPool(this.#connectionString);
				await this.#pool.query('SELECT 1');
			} else {
				throw error;
			}
		}

		await this.#pool.query(`
			CREATE TABLE IF NOT EXISTS bot_cycles (
				id BIGSERIAL PRIMARY KEY,
				cycle_number INTEGER NOT NULL,
				status TEXT NOT NULL,
				planned_notional_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				volume_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				fees_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				gas_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				hold_seconds_target INTEGER NOT NULL DEFAULT 0,
				hold_seconds_actual INTEGER NOT NULL DEFAULT 0,
				open_price DOUBLE PRECISION NOT NULL DEFAULT 0,
				close_price DOUBLE PRECISION NOT NULL DEFAULT 0,
				account_a_manager_id TEXT,
				account_b_manager_id TEXT,
				orders JSONB NOT NULL DEFAULT '[]'::jsonb,
				note TEXT,
				started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				hold_started_at TIMESTAMPTZ,
				completed_at TIMESTAMPTZ
			);
		`);

		await this.#pool.query(`
			CREATE TABLE IF NOT EXISTS bot_logs (
				id BIGSERIAL PRIMARY KEY,
				level TEXT NOT NULL,
				message TEXT NOT NULL,
				meta JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
		`);

		await this.#pool.query(`
			CREATE TABLE IF NOT EXISTS bot_runtime_state (
				state_key TEXT PRIMARY KEY,
				state_value JSONB NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
		`);

		await this.#pool.query(`
			CREATE TABLE IF NOT EXISTS bot_manager_cache (
				manager_id TEXT PRIMARY KEY,
				account_key TEXT NOT NULL,
				owner_address TEXT NOT NULL,
				pool_id TEXT,
				balance_manager_id TEXT,
				status TEXT NOT NULL DEFAULT 'unknown',
				open_orders_count INTEGER NOT NULL DEFAULT 0,
				base_asset DOUBLE PRECISION NOT NULL DEFAULT 0,
				quote_asset DOUBLE PRECISION NOT NULL DEFAULT 0,
				base_debt DOUBLE PRECISION NOT NULL DEFAULT 0,
				quote_debt DOUBLE PRECISION NOT NULL DEFAULT 0,
				last_verified_at TIMESTAMPTZ,
				last_cleanup_at TIMESTAMPTZ,
				last_cleanup_error TEXT,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
		`);

		await this.#pool.query(`
			CREATE INDEX IF NOT EXISTS bot_manager_cache_account_idx
			ON bot_manager_cache (account_key, owner_address, updated_at DESC);
		`);

		await this.#ensureRecoveryEventsTable();

		await this.#pool.query(`
			CREATE TABLE IF NOT EXISTS bot_settings (
				settings_key TEXT PRIMARY KEY,
				network TEXT NOT NULL,
				rpc_url TEXT NOT NULL,
				experimental_deeptrade_limit_ptb BOOLEAN NOT NULL DEFAULT FALSE,
				deeptrade_orderbook_api_base TEXT NOT NULL,
				pool_key TEXT NOT NULL,
				account_a_label TEXT NOT NULL,
				account_b_label TEXT NOT NULL,
				private_key_a_encrypted TEXT,
				private_key_b_encrypted TEXT,
				notional_size_usd DOUBLE PRECISION NOT NULL,
				min_hold_seconds INTEGER NOT NULL,
				max_hold_seconds INTEGER NOT NULL,
				max_cycles INTEGER,
				slippage_tolerance DOUBLE PRECISION NOT NULL,
				random_size_bps INTEGER NOT NULL,
				min_order_delay_ms INTEGER NOT NULL,
				max_order_delay_ms INTEGER NOT NULL,
				open_order_execution_mode TEXT NOT NULL DEFAULT 'limit',
				close_order_execution_mode TEXT NOT NULL DEFAULT 'limit',
				auto_swap_enabled BOOLEAN NOT NULL,
				auto_swap_buffer_bps INTEGER NOT NULL,
				min_gas_reserve_sui DOUBLE PRECISION NOT NULL,
				order_poll_interval_ms INTEGER NOT NULL,
				maker_reprice_seconds INTEGER NOT NULL,
				force_market_close_seconds INTEGER NOT NULL,
				account_a_margin_manager_id TEXT,
				account_b_margin_manager_id TEXT,
				account_a_borrow_quote_factor DOUBLE PRECISION NOT NULL,
				account_b_borrow_base_factor DOUBLE PRECISION NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
		`);

		await this.#pool.query(
			`ALTER TABLE bot_cycles ADD COLUMN IF NOT EXISTS gas_usd DOUBLE PRECISION NOT NULL DEFAULT 0`
		);
		await this.#pool.query(
			`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS experimental_deeptrade_limit_ptb BOOLEAN NOT NULL DEFAULT FALSE`
		);
		await this.#pool.query(
			`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS open_order_execution_mode TEXT NOT NULL DEFAULT 'limit'`
		);
		await this.#pool.query(
			`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS close_order_execution_mode TEXT NOT NULL DEFAULT 'limit'`
		);
		await this.#pool.query(
			`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS notional_auto_reduce_floor_pct DOUBLE PRECISION NOT NULL DEFAULT 100`
		);

		await this.#seedDefaultSettings();
	}

	async disconnect(): Promise<void> {
		sharedPools().delete(this.#connectionString);
		await this.#pool.end();
	}

	async #ensureRecoveryEventsTable(): Promise<void> {
		if (this.#recoveryEventsTableReady) {
			return;
		}

		await this.#pool.query(`
			CREATE TABLE IF NOT EXISTS bot_recovery_events (
				id BIGSERIAL PRIMARY KEY,
				cleanup_run_id TEXT NOT NULL,
				account_key TEXT NOT NULL,
				manager_id TEXT,
				side TEXT NOT NULL,
				cycle_number INTEGER,
				quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
				entry_price DOUBLE PRECISION NOT NULL DEFAULT 0,
				exit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
				pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				gas_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
				tx_digest TEXT,
				note TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
		`);

		await this.#pool.query(`
			CREATE INDEX IF NOT EXISTS bot_recovery_events_cleanup_idx
			ON bot_recovery_events (cleanup_run_id, created_at DESC);
		`);

		this.#recoveryEventsTableReady = true;
	}

	async appendLog(
		level: BotLogEntry['level'],
		message: string,
		meta: Record<string, unknown>
	): Promise<BotLogEntry> {
		const result = await this.#pool.query<{
			id: string;
			level: BotLogEntry['level'];
			message: string;
			meta: Record<string, unknown>;
			created_at: Date;
		}>(
			`INSERT INTO bot_logs (level, message, meta)
			 VALUES ($1, $2, $3::jsonb)
			 RETURNING id, level, message, meta, created_at`,
			[level, message, JSON.stringify(meta)]
		);

		const row = result.rows[0];
		return {
			id: Number(row.id),
			level: row.level,
			message: row.message,
			meta: row.meta,
			createdAt: row.created_at.toISOString()
		};
	}

	async listLogs(groupLimit = 8, systemLimit = 20): Promise<BotLogEntry[]> {
		const result = await this.#pool.query<{
			id: string;
			level: BotLogEntry['level'];
			message: string;
			meta: Record<string, unknown>;
			created_at: Date;
		}>(
			`WITH annotated AS (
				SELECT
					id,
					level,
					message,
					meta,
					created_at,
					CASE
						WHEN COALESCE(meta->>'cleanupRunId', '') <> '' THEN 'cleanup-' || (meta->>'cleanupRunId')
						WHEN COALESCE(meta->>'cycleNumber', '') ~ '^[0-9]+$' THEN 'cycle-' || (meta->>'cycleNumber')
						ELSE 'system'
					END AS group_key
				FROM bot_logs
			),
			recent_groups AS (
				SELECT group_key, MAX(id) AS latest_id
				FROM annotated
				WHERE group_key <> 'system'
				GROUP BY group_key
				ORDER BY latest_id DESC
				LIMIT $1
			),
			selected AS (
				SELECT a.id, a.level, a.message, a.meta, a.created_at
				FROM annotated a
				INNER JOIN recent_groups g ON g.group_key = a.group_key
				UNION ALL
				SELECT s.id, s.level, s.message, s.meta, s.created_at
				FROM (
					SELECT id, level, message, meta, created_at
					FROM annotated
					WHERE group_key = 'system'
					ORDER BY id DESC
					LIMIT $2
				) s
			)
			SELECT id, level, message, meta, created_at
			FROM selected
			ORDER BY id ASC`,
			[groupLimit, systemLimit]
		);

		return result.rows
			.reverse()
			.map(
				(row: {
					id: string;
					level: BotLogEntry['level'];
					message: string;
					meta: Record<string, unknown>;
					created_at: Date;
				}) => ({
					id: Number(row.id),
					level: row.level,
					message: row.message,
					meta: row.meta,
					createdAt: row.created_at.toISOString()
				})
			);
	}

	async appendRecoveryEvent(input: {
		cleanupRunId: string;
		accountKey: string;
		managerId?: string;
		side: 'LONG' | 'SHORT';
		cycleNumber?: number | null;
		quantity: number;
		entryPrice: number;
		exitPrice: number;
		pnlUsd: number;
		gasUsd: number;
		txDigest?: string;
		note?: string;
	}): Promise<void> {
		await this.#ensureRecoveryEventsTable();
		await this.#pool.query(
			`INSERT INTO bot_recovery_events (
				cleanup_run_id,
				account_key,
				manager_id,
				side,
				cycle_number,
				quantity,
				entry_price,
				exit_price,
				pnl_usd,
				gas_usd,
				tx_digest,
				note
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			[
				input.cleanupRunId,
				input.accountKey,
				input.managerId ?? null,
				input.side,
				input.cycleNumber ?? null,
				input.quantity,
				input.entryPrice,
				input.exitPrice,
				input.pnlUsd,
				input.gasUsd,
				input.txDigest ?? null,
				input.note ?? null
			]
		);
	}

	async createCycle(input: {
		cycleNumber: number;
		plannedNotionalUsd: number;
		holdSecondsTarget: number;
		openPrice: number;
		accountAManagerId?: string;
		accountBManagerId?: string;
		orders: CycleHistoryRecord['orders'];
	}): Promise<number> {
		const result = await this.#pool.query<{ id: string }>(
			`INSERT INTO bot_cycles (
				cycle_number,
				status,
				planned_notional_usd,
				hold_seconds_target,
				open_price,
				account_a_manager_id,
				account_b_manager_id,
				orders
			) VALUES ($1, 'running', $2, $3, $4, $5, $6, $7::jsonb)
			RETURNING id`,
			[
				input.cycleNumber,
				input.plannedNotionalUsd,
				input.holdSecondsTarget,
				input.openPrice,
				input.accountAManagerId ?? null,
				input.accountBManagerId ?? null,
				JSON.stringify(input.orders)
			]
		);

		return Number(result.rows[0].id);
	}

	async getNextCycleNumber(): Promise<number> {
		const result = await this.#pool.query<{ next_cycle_number: string }>(
			`SELECT COALESCE(MAX(cycle_number), 0) + 1 AS next_cycle_number
			 FROM bot_cycles`
		);

		return Number(result.rows[0]?.next_cycle_number ?? 1);
	}

	async markCycleHolding(cycleId: number, holdStartedAt: Date): Promise<void> {
		await this.#pool.query(`UPDATE bot_cycles SET hold_started_at = $2 WHERE id = $1`, [
			cycleId,
			holdStartedAt
		]);
	}

	async updateCycleOrders(
		cycleId: number,
		orders: CycleHistoryRecord['orders'],
		overrides: { feesUsd?: number; gasUsd?: number; volumeUsd?: number } = {}
	): Promise<void> {
		await this.#pool.query(
			`UPDATE bot_cycles
			 SET orders = $2::jsonb,
			     fees_usd = $3,
			     gas_usd = $4,
			     volume_usd = $5
			 WHERE id = $1`,
			[
				cycleId,
				JSON.stringify(orders),
				overrides.feesUsd ?? sumCycleOrderFeesUsd(orders),
				overrides.gasUsd ?? sumCycleOrderGasUsd(orders),
				overrides.volumeUsd ?? sumFilledCycleOrderVolumeUsd(orders)
			]
		);
	}

	async finishCycle(
		cycleId: number,
		input: {
			status: CycleHistoryRecord['status'];
			volumeUsd: number;
			feesUsd: number;
			gasUsd: number;
			pnlUsd: number;
			holdSecondsActual: number;
			closePrice: number;
			orders: CycleHistoryRecord['orders'];
			note?: string;
		}
	): Promise<void> {
		await this.#pool.query(
			`UPDATE bot_cycles
			 SET status = $2,
			     volume_usd = $3,
			     fees_usd = $4,
			     gas_usd = $5,
			     pnl_usd = $6,
			     hold_seconds_actual = $7,
			     close_price = $8,
			     orders = $9::jsonb,
			     note = $10,
			     completed_at = NOW()
			 WHERE id = $1`,
			[
				cycleId,
				input.status,
				input.volumeUsd,
				input.feesUsd,
				input.gasUsd,
				input.pnlUsd,
				input.holdSecondsActual,
				input.closePrice,
				JSON.stringify(input.orders),
				input.note ?? null
			]
		);
	}

	async listRecentCycles(limit = 12): Promise<CycleHistoryRecord[]> {
		const result = await this.#pool.query<CycleRow>(
			`SELECT *
			 FROM bot_cycles
			 ORDER BY started_at DESC, id DESC
			 LIMIT $1`,
			[limit]
		);

		return result.rows.map((row: CycleRow) => ({
			id: row.id,
			cycleNumber: row.cycle_number,
			status: row.status,
			plannedNotionalUsd: row.planned_notional_usd,
			volumeUsd: row.volume_usd,
			feesUsd: row.fees_usd,
			gasUsd: row.gas_usd,
			pnlUsd: row.pnl_usd,
			holdSecondsTarget: row.hold_seconds_target,
			holdSecondsActual: row.hold_seconds_actual,
			openPrice: row.open_price,
			closePrice: row.close_price,
			startedAt: row.started_at.toISOString(),
			holdStartedAt: row.hold_started_at?.toISOString(),
			completedAt: row.completed_at?.toISOString(),
			accountAManagerId: row.account_a_manager_id ?? undefined,
			accountBManagerId: row.account_b_manager_id ?? undefined,
			orders: row.orders,
			note: row.note ?? undefined
		}));
	}

	async getDashboardStats(): Promise<DashboardStats> {
		await this.#ensureRecoveryEventsTable();
		const todayStart = new Date();
		todayStart.setHours(0, 0, 0, 0);

		const [allTime, today, recoveryAllTime] = await Promise.all([
			this.#pool.query<{
				total_volume: string | null;
				cycles_completed: string | null;
				total_pnl: string | null;
				total_fees: string | null;
				total_gas: string | null;
			}>(
				`SELECT
					COALESCE(SUM(volume_usd), 0) AS total_volume,
					COUNT(*) FILTER (WHERE status = 'completed') AS cycles_completed,
					COALESCE(SUM(pnl_usd), 0) AS total_pnl,
					COALESCE(SUM(fees_usd), 0) AS total_fees,
					COALESCE(SUM(gas_usd), 0) AS total_gas
				 FROM bot_cycles
				 WHERE completed_at IS NOT NULL`
			),
			this.#pool.query<{ today_volume: string | null }>(
				`SELECT COALESCE(SUM(volume_usd), 0) AS today_volume
				 FROM bot_cycles
				 WHERE completed_at IS NOT NULL AND completed_at >= $1`,
				[todayStart]
			),
			this.#pool.query<{
				total_pnl: string | null;
				total_gas: string | null;
			}>(
				`SELECT
					COALESCE(SUM(pnl_usd), 0) AS total_pnl,
					COALESCE(SUM(gas_usd), 0) AS total_gas
				 FROM bot_recovery_events`
			)
		]);

		const totalVolumeAllTime = Number(allTime.rows[0]?.total_volume ?? 0);
		const totalVolumeToday = Number(today.rows[0]?.today_volume ?? 0);
		const recoveryPnl = Number(recoveryAllTime.rows[0]?.total_pnl ?? 0);
		const recoveryGas = Number(recoveryAllTime.rows[0]?.total_gas ?? 0);

		return {
			totalVolumeAllTime,
			totalVolumeToday,
			totalVolumeAccountA: totalVolumeAllTime / 2,
			totalVolumeAccountB: totalVolumeAllTime / 2,
			sessionPnl: Number(allTime.rows[0]?.total_pnl ?? 0) + recoveryPnl,
			sessionFees: Number(allTime.rows[0]?.total_fees ?? 0),
			sessionGas: Number(allTime.rows[0]?.total_gas ?? 0) + recoveryGas,
			cyclesCompleted: Number(allTime.rows[0]?.cycles_completed ?? 0),
			updatedAt: new Date().toISOString()
		};
	}

	async countCyclesSince(startedAt: Date): Promise<number> {
		const result = await this.#pool.query<{ total: string }>(
			`SELECT COUNT(*)::text AS total
			 FROM bot_cycles
			 WHERE started_at >= $1`,
			[startedAt]
		);
		return Number(result.rows[0]?.total ?? 0);
	}

	async saveAccountState(value: Record<string, string | undefined>): Promise<void> {
		await this.#pool.query(
			`INSERT INTO bot_runtime_state (state_key, state_value, updated_at)
			 VALUES ('accounts', $1::jsonb, NOW())
			 ON CONFLICT (state_key)
			 DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()`,
			[JSON.stringify(value)]
		);
	}

	async loadAccountState(): Promise<Record<string, string | undefined>> {
		const result = await this.#pool.query<{ state_value: Record<string, string | undefined> }>(
			`SELECT state_value FROM bot_runtime_state WHERE state_key = 'accounts'`
		);
		return result.rows[0]?.state_value ?? {};
	}

	async getSettings(): Promise<BotSettingsRow> {
		const result = await this.#pool.query<BotSettingsRow>(
			`SELECT *
			 FROM bot_settings
			 WHERE settings_key = $1`,
			[BOT_SETTINGS_KEY]
		);

		if (result.rows[0]) {
			return result.rows[0];
		}

		await this.#seedDefaultSettings();
		const seeded = await this.#pool.query<BotSettingsRow>(
			`SELECT *
			 FROM bot_settings
			 WHERE settings_key = $1`,
			[BOT_SETTINGS_KEY]
		);
		if (!seeded.rows[0]) {
			throw new Error('Failed to initialize bot settings');
		}
		return seeded.rows[0];
	}

	async saveSettings(input: SaveBotSettingsInput): Promise<BotSettingsRow> {
		const current = await this.getSettings();
		const privateKeyAEncrypted =
			input.private_key_A !== undefined
				? input.private_key_A.trim().length > 0
					? encryptSecret(input.private_key_A.trim())
					: null
				: current.private_key_a_encrypted;
		const privateKeyBEncrypted =
			input.private_key_B !== undefined
				? input.private_key_B.trim().length > 0
					? encryptSecret(input.private_key_B.trim())
					: null
				: current.private_key_b_encrypted;

		const result = await this.#pool.query<BotSettingsRow>(
			`UPDATE bot_settings
			 SET network = $2,
			     rpc_url = $3,
			     experimental_deeptrade_limit_ptb = $4,
			     deeptrade_orderbook_api_base = $5,
			     pool_key = $6,
			     account_a_label = $7,
			     account_b_label = $8,
			     private_key_a_encrypted = $9,
			     private_key_b_encrypted = $10,
			     notional_size_usd = $11,
			     min_hold_seconds = $12,
			     max_hold_seconds = $13,
			     max_cycles = $14,
			     slippage_tolerance = $15,
			     random_size_bps = $16,
			     min_order_delay_ms = $17,
			     max_order_delay_ms = $18,
			     open_order_execution_mode = $19,
			     close_order_execution_mode = $20,
			     auto_swap_enabled = $21,
			     auto_swap_buffer_bps = $22,
			     min_gas_reserve_sui = $23,
			     order_poll_interval_ms = $24,
			     maker_reprice_seconds = $25,
			     force_market_close_seconds = $26,
			     account_a_margin_manager_id = $27,
			     account_b_margin_manager_id = $28,
			     account_a_borrow_quote_factor = $29,
			     account_b_borrow_base_factor = $30,
			     notional_auto_reduce_floor_pct = $31,
			     updated_at = NOW()
			 WHERE settings_key = $1
			 RETURNING *`,
			[
				BOT_SETTINGS_KEY,
				input.network,
				input.rpc_url,
				input.experimental_deeptrade_limit_ptb,
				input.deeptrade_orderbook_api_base,
				input.pool_key,
				input.account_a_label,
				input.account_b_label,
				privateKeyAEncrypted,
				privateKeyBEncrypted,
				input.notional_size_usd,
				input.min_hold_seconds,
				input.max_hold_seconds,
				input.max_cycles,
				input.slippage_tolerance,
				input.random_size_bps,
				input.min_order_delay_ms,
				input.max_order_delay_ms,
				input.open_order_execution_mode,
				input.close_order_execution_mode,
				input.auto_swap_enabled,
				input.auto_swap_buffer_bps,
				input.min_gas_reserve_sui,
				input.order_poll_interval_ms,
				input.maker_reprice_seconds,
				input.force_market_close_seconds,
				input.account_a_margin_manager_id ?? null,
				input.account_b_margin_manager_id ?? null,
				input.account_a_borrow_quote_factor,
				input.account_b_borrow_base_factor,
				input.notional_auto_reduce_floor_pct
			]
		);
		return result.rows[0];
	}

	async swapAccountKeys(): Promise<BotSettingsRow> {
		const result = await this.#pool.query<BotSettingsRow>(
			`UPDATE bot_settings
			 SET private_key_a_encrypted = private_key_b_encrypted,
			     private_key_b_encrypted = private_key_a_encrypted,
			     account_a_label = account_b_label,
			     account_b_label = account_a_label,
			     account_a_margin_manager_id = account_b_margin_manager_id,
			     account_b_margin_manager_id = account_a_margin_manager_id,
			     updated_at = NOW()
			 WHERE settings_key = $1
			 RETURNING *`,
			[BOT_SETTINGS_KEY]
		);
		if (!result.rows[0]) {
			throw new Error('Failed to swap accounts. Settings not found.');
		}
		return result.rows[0];
	}

	async upsertManagerCache(entries: ManagerCacheUpsert[]): Promise<void> {
		if (entries.length === 0) {
			return;
		}

		const client = await this.#pool.connect();
		try {
			await client.query('BEGIN');
			for (const entry of entries) {
				await client.query(
					`INSERT INTO bot_manager_cache (
						manager_id,
						account_key,
						owner_address,
						pool_id,
						balance_manager_id,
						status,
						open_orders_count,
						base_asset,
						quote_asset,
						base_debt,
						quote_debt,
						last_verified_at,
						last_cleanup_at,
						last_cleanup_error,
						updated_at
					) VALUES (
						$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
					)
					ON CONFLICT (manager_id)
					DO UPDATE SET
						account_key = EXCLUDED.account_key,
						owner_address = EXCLUDED.owner_address,
						pool_id = COALESCE(EXCLUDED.pool_id, bot_manager_cache.pool_id),
						balance_manager_id = COALESCE(EXCLUDED.balance_manager_id, bot_manager_cache.balance_manager_id),
						status = EXCLUDED.status,
						open_orders_count = EXCLUDED.open_orders_count,
						base_asset = EXCLUDED.base_asset,
						quote_asset = EXCLUDED.quote_asset,
						base_debt = EXCLUDED.base_debt,
						quote_debt = EXCLUDED.quote_debt,
						last_verified_at = COALESCE(EXCLUDED.last_verified_at, bot_manager_cache.last_verified_at),
						last_cleanup_at = COALESCE(EXCLUDED.last_cleanup_at, bot_manager_cache.last_cleanup_at),
						last_cleanup_error = EXCLUDED.last_cleanup_error,
						updated_at = NOW()`,
					[
						entry.managerId,
						entry.accountKey,
						entry.ownerAddress,
						entry.poolId ?? null,
						entry.balanceManagerId ?? null,
						entry.status,
						entry.openOrdersCount ?? 0,
						entry.baseAsset ?? 0,
						entry.quoteAsset ?? 0,
						entry.baseDebt ?? 0,
						entry.quoteDebt ?? 0,
						entry.lastVerifiedAt ?? null,
						entry.lastCleanupAt ?? null,
						entry.lastCleanupError ?? null
					]
				);
			}
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	async listManagerCache(accountKey: string, ownerAddress: string): Promise<ManagerCacheRecord[]> {
		const result = await this.#pool.query<ManagerCacheRow>(
			`SELECT
				manager_id,
				account_key,
				owner_address,
				pool_id,
				balance_manager_id,
				status,
				open_orders_count,
				base_asset,
				quote_asset,
				base_debt,
				quote_debt,
				last_verified_at,
				last_cleanup_at,
				last_cleanup_error,
				updated_at
			 FROM bot_manager_cache
			 WHERE account_key = $1 AND owner_address = $2
			 ORDER BY updated_at DESC`,
			[accountKey, ownerAddress]
		);

		return result.rows.map((row) => ({
			managerId: row.manager_id,
			accountKey: row.account_key,
			ownerAddress: row.owner_address,
			poolId: row.pool_id ?? undefined,
			balanceManagerId: row.balance_manager_id ?? undefined,
			status: row.status,
			openOrdersCount: row.open_orders_count ?? 0,
			baseAsset: row.base_asset ?? 0,
			quoteAsset: row.quote_asset ?? 0,
			baseDebt: row.base_debt ?? 0,
			quoteDebt: row.quote_debt ?? 0,
			lastVerifiedAt: row.last_verified_at?.toISOString(),
			lastCleanupAt: row.last_cleanup_at?.toISOString(),
			lastCleanupError: row.last_cleanup_error ?? undefined,
			updatedAt: row.updated_at.toISOString()
		}));
	}

	async clearAllData(): Promise<void> {
		await this.#pool.query(
			'TRUNCATE TABLE bot_cycles, bot_logs, bot_runtime_state RESTART IDENTITY'
		);
	}

	async clearLogs(): Promise<void> {
		await this.#pool.query('TRUNCATE TABLE bot_logs RESTART IDENTITY');
	}

	async #ensureDatabaseExists(): Promise<void> {
		const url = new URL(this.#connectionString);
		const databaseName = url.pathname.replace(/^\//, '');
		if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
			throw new Error(`Refusing to auto-create database with unsafe name: ${databaseName}`);
		}

		url.pathname = '/postgres';
		const adminPool = createPool(url.toString());
		try {
			const existing = await adminPool.query<{ datname: string }>(
				'SELECT datname FROM pg_database WHERE datname = $1',
				[databaseName]
			);
			if (existing.rowCount === 0) {
				await adminPool.query(`CREATE DATABASE "${databaseName}"`);
			}
		} finally {
			await adminPool.end();
		}
	}

	async #seedDefaultSettings(): Promise<void> {
		const defaults = buildDefaultSettingsRow();
		await this.#pool.query(
			`INSERT INTO bot_settings (
				settings_key,
				network,
				rpc_url,
				experimental_deeptrade_limit_ptb,
				deeptrade_orderbook_api_base,
				pool_key,
				account_a_label,
				account_b_label,
				private_key_a_encrypted,
				private_key_b_encrypted,
				notional_size_usd,
				min_hold_seconds,
				max_hold_seconds,
				max_cycles,
				slippage_tolerance,
				random_size_bps,
				min_order_delay_ms,
				max_order_delay_ms,
				open_order_execution_mode,
				close_order_execution_mode,
				auto_swap_enabled,
				auto_swap_buffer_bps,
				min_gas_reserve_sui,
				order_poll_interval_ms,
				maker_reprice_seconds,
				force_market_close_seconds,
				account_a_margin_manager_id,
				account_b_margin_manager_id,
				account_a_borrow_quote_factor,
				account_b_borrow_base_factor,
				notional_auto_reduce_floor_pct,
				created_at,
				updated_at
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW(), NOW()
			)
			ON CONFLICT (settings_key) DO NOTHING`,
			[
				BOT_SETTINGS_KEY,
				defaults.network,
				defaults.rpc_url,
				defaults.experimental_deeptrade_limit_ptb,
				defaults.deeptrade_orderbook_api_base,
				defaults.pool_key,
				defaults.account_a_label,
				defaults.account_b_label,
				defaults.notional_size_usd,
				defaults.min_hold_seconds,
				defaults.max_hold_seconds,
				defaults.max_cycles,
				defaults.slippage_tolerance,
				defaults.random_size_bps,
				defaults.min_order_delay_ms,
				defaults.max_order_delay_ms,
				defaults.open_order_execution_mode,
				defaults.close_order_execution_mode,
				defaults.auto_swap_enabled,
				defaults.auto_swap_buffer_bps,
				defaults.min_gas_reserve_sui,
				defaults.order_poll_interval_ms,
				defaults.maker_reprice_seconds,
				defaults.force_market_close_seconds,
				defaults.account_a_margin_manager_id,
				defaults.account_b_margin_manager_id,
				defaults.account_a_borrow_quote_factor,
				defaults.account_b_borrow_base_factor,
				defaults.notional_auto_reduce_floor_pct
			]
		);
	}
}
