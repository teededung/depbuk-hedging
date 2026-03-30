import type { BotAccountKey, BotOrderPhase, BotSettingsView, RuntimeSnapshot } from '$lib/types/bot.js';
import { createDefaultSettingsView } from '$lib/bot-settings-defaults.js';

export type SettingsForm = BotSettingsView & {
	private_key_A: string;
	private_key_B: string;
};

export type SettingsFormErrors = Record<'general' | 'cycle' | 'execution' | 'accounts', string | null>;

export type LogEntry = RuntimeSnapshot['logs'][number];
export type LogGroup = {
	key: string;
	label: string;
	cycleNumber: number | null;
	kind: 'cycle' | 'cleanup' | 'system';
	logs: LogEntry[];
};
export type LogPhaseGroupKey = 'OPEN' | 'HOLD' | 'CLOSE' | 'GENERAL';
export type LogSummary = {
	key: string;
	message: string;
	level: LogEntry['level'];
	logs: LogEntry[];
	latestAt: string;
	attempts: number[];
	detail?: string;
	txDigest?: string;
	isFatal: boolean;
	phase?: LogPhaseGroupKey;
};

export type HighlightedLabelMessageParts = {
	prefix: string;
	label: string;
	suffix: string;
};

export type FillToastSummary = {
	title: string;
	message: string;
	txDigest: string;
};

export type CycleToastSummary = {
	title: string;
	message: string;
};

export type HoldingToastSummary = {
	title: string;
	message: string;
};

export type PhaseSummary = LogSummary & {
	phaseKey: LogPhaseGroupKey;
	phaseLabel: string;
};

export type LogSplit = {
	systemGroup: LogGroup | null;
	cleanupGroups: LogGroup[];
	cycleGroups: LogGroup[];
};

export const pct = (value: number, total: number): number => {
	if (!total || total <= 0) return 0;
	return Math.max(0, Math.min(100, (value / total) * 100));
};

export const clonePreflight = (
	preflight: RuntimeSnapshot['preflight']
): RuntimeSnapshot['preflight'] => ({
	...preflight,
	accountA: { ...preflight.accountA },
	accountB: { ...preflight.accountB }
});

export const createBlankSettingsForm = (): SettingsForm => ({
	...createDefaultSettingsView(),
	private_key_A: '',
	private_key_B: ''
});

export const toSettingsForm = (settings: BotSettingsView): SettingsForm => ({
	...settings,
	private_key_A: '',
	private_key_B: ''
});

export const createBlankSettingsErrors = (): SettingsFormErrors => ({
	general: null,
	cycle: null,
	execution: null,
	accounts: null
});

export const buildSettingsValidationErrors = (settingsForm: SettingsForm): SettingsFormErrors => {
	const errors = createBlankSettingsErrors();

	if (
		!settingsForm.rpc_url.trim() ||
		!settingsForm.deeptrade_orderbook_api_base.trim() ||
		!settingsForm.pool_key.trim()
	) {
		errors.general = 'At least one RPC endpoint, the orderbook API base, and the pool key are required.';
	}

	if (
		!Number.isFinite(settingsForm.notional_size_usd) ||
		settingsForm.notional_size_usd <= 0 ||
		settingsForm.min_hold_seconds <= 0 ||
		settingsForm.max_hold_seconds <= 0 ||
		settingsForm.min_hold_seconds > settingsForm.max_hold_seconds ||
		!Number.isFinite(settingsForm.slippage_tolerance) ||
		settingsForm.slippage_tolerance < 0.001 ||
		settingsForm.slippage_tolerance > 0.1
	) {
		errors.cycle =
			'Cycle fields must be positive, hold range must be valid, and slippage must stay between 0.1% and 10%.';
	}

	if (
		settingsForm.min_order_delay_ms < 0 ||
		settingsForm.max_order_delay_ms < settingsForm.min_order_delay_ms ||
		settingsForm.order_poll_interval_ms <= 0 ||
		settingsForm.maker_reprice_seconds <= 0 ||
		settingsForm.force_market_close_seconds <= 0
	) {
		errors.execution = 'Execution delays and retry windows must be valid positive values.';
	}

	if (!settingsForm.account_a_label || !settingsForm.account_b_label) {
		errors.accounts = 'Both account labels are required.';
	}
	if (!settingsForm.has_private_key_a && !settingsForm.private_key_A.trim()) {
		errors.accounts = 'Private key A is required before the bot can start.';
	}
	if (!settingsForm.has_private_key_b && !settingsForm.private_key_B.trim()) {
		errors.accounts = 'Private key B is required before the bot can start.';
	}

	return errors;
};

export const currency = (value: number, digits = 2): string =>
	new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(value ?? 0);

export const formatNumber = (value: number, digits = 2): string =>
	new Intl.NumberFormat('en-US', {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(value ?? 0);

export const formatAssetAmount = (value: number, asset?: 'SUI' | 'USDC'): string =>
	`${formatNumber(value, asset === 'SUI' ? 4 : 2)} ${asset ?? ''}`.trim();

export const formatClock = (seconds: number): string => {
	const safe = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(safe / 60);
	const secs = safe % 60;
	return `${mins}m ${secs.toString().padStart(2, '0')}s`;
};

export const formatDateTime = (value?: string): string => {
	if (!value) return '-';
	return new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		day: '2-digit',
		month: 'short'
	}).format(new Date(value));
};

export const shortAddress = (value?: string): string => {
	if (!value) return 'n/a';
	return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const shortHash = (value?: string): string => {
	if (!value) return 'n/a';
	return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
};

export const normalizeDisplayError = (error?: string): string | undefined => {
	if (!error) return error;
	if (error.includes('balance_manager::withdraw_with_proof') || error.includes('withdraw_with_proof')) {
		return 'Margin funding not available yet.';
	}
	if (
		(error.includes('Identifier("margin_manager")') || error.includes('margin_manager::withdraw')) &&
		error.includes('Some("withdraw")')
	) {
		return 'Margin assets are not withdrawable yet.';
	}
	return error;
};

export const suiscanTxUrl = (txDigest: string, network: 'mainnet' | 'testnet' = 'mainnet'): string =>
	network === 'testnet'
		? `https://suiscan.xyz/testnet/tx/${txDigest}`
		: `https://suiscan.xyz/mainnet/tx/${txDigest}`;

export const cycleNumberFromLog = (log: LogEntry): number | null => {
	const metaCycle = Number((log.meta ?? {})['cycleNumber']);
	if (Number.isFinite(metaCycle) && metaCycle > 0) {
		return metaCycle;
	}

	const match = log.message.match(/cycle\s+#(\d+)/i);
	return match ? Number(match[1]) : null;
};

export const logAccountKey = (
	log: LogEntry,
	labels: { accountALabel?: string | null; accountBLabel?: string | null } = {}
): 'accountA' | 'accountB' | 'shared' => {
	const metaAccountKey = String(log.meta?.accountKey ?? '').toLowerCase();
	const metaAccount = String(log.meta?.account ?? '').toLowerCase();
	const message = log.message.toLowerCase();
	const accountALabel = String(labels.accountALabel ?? '').toLowerCase();
	const accountBLabel = String(labels.accountBLabel ?? '').toLowerCase();

	if (metaAccountKey === 'accounta') {
		return 'accountA';
	}
	if (metaAccountKey === 'accountb') {
		return 'accountB';
	}
	if (
		metaAccount.includes('account a') ||
		metaAccount.includes('long') ||
		(accountALabel && metaAccount === accountALabel) ||
		message.includes('long ')
	) {
		return 'accountA';
	}
	if (
		metaAccount.includes('account b') ||
		metaAccount.includes('short') ||
		(accountBLabel && metaAccount === accountBLabel) ||
		message.includes('short ')
	) {
		return 'accountB';
	}
	return 'shared';
};

export const isFatalLogMessage = (message: string): boolean => {
	const normalized = message.toLowerCase();
	return (
		normalized.includes('not enough coins of type') ||
		normalized.includes('no valid gas coins found')
	);
};

export const hasNoOnChainExecution = (summary: LogSummary): boolean => {
	const normalizedMessage = summary.message.toLowerCase();
	const normalizedDetail = summary.detail?.toLowerCase() ?? '';
	return (
		normalizedMessage.includes('before confirmation') ||
		normalizedDetail.includes('before confirmation') ||
		(normalizedMessage.includes('maker order failed') && !normalizedDetail.includes('txdigest'))
	);
};

export const isRetryableSubmissionWarning = (summary: LogSummary): boolean =>
	summary.level === 'warn' &&
	!summary.isFatal &&
	summary.logs.some((log) => {
		const normalizedMessage = log.message.toLowerCase();
		return (
			(normalizedMessage.includes('maker order failed') ||
				normalizedMessage.includes('market order failed')) &&
			Number.isFinite(Number(log.meta?.attempt))
		);
	});

export const parseHighlightedLabelMessage = (
	message: string,
	accountLabel?: string | null
): HighlightedLabelMessageParts | null => {
	const normalizedAccountLabel = accountLabel?.trim();
	if (!normalizedAccountLabel) return null;
	const marker = `for ${normalizedAccountLabel}`;
	const startIndex = message.indexOf(marker);
	if (startIndex < 0) return null;

	const prefix = message.slice(0, startIndex) + 'for ';
	const label = normalizedAccountLabel;
	const rawSuffix = message.slice(startIndex + marker.length);
	const suffix = rawSuffix === '.' ? '' : rawSuffix;

	return {
		prefix,
		label,
		suffix
	};
};

export const summarizeHoldingToastLog = (
	log: LogEntry,
	logs: LogEntry[]
): HoldingToastSummary | null => {
	const match = log.message.match(/^Cycle #(\d+) entered holding window\.?$/);
	if (!match) return null;

	const cycleNumber = Number(match[1]);
	const fillLogs = logs.filter((entry) => {
		const normalizedMessage = entry.message.toLowerCase();
		return (
			Number(entry.meta?.cycleNumber) === cycleNumber &&
			String(entry.meta?.phase ?? '').toUpperCase() === 'HOLD' &&
			(normalizedMessage.includes('long leg is filled') ||
				normalizedMessage.includes('short leg is filled'))
		);
	});

	const summarizeLeg = (side: 'LONG' | 'SHORT') => {
		const sideLog = fillLogs.find((entry) => String(entry.meta?.side ?? '').toUpperCase() === side);
		if (!sideLog) return null;
		const account = typeof sideLog.meta?.account === 'string' ? sideLog.meta.account : side;
		const quantityValue = Number(sideLog.meta?.quantity);
		const fillPriceValue = Number(sideLog.meta?.fillPrice);
		const quantity =
			Number.isFinite(quantityValue) && quantityValue > 0
				? formatAssetAmount(quantityValue, 'SUI')
				: 'n/a';
		const fillPrice =
			Number.isFinite(fillPriceValue) && fillPriceValue > 0
				? currency(fillPriceValue, 4)
				: 'n/a';
		return `${side} ${account} · ${quantity} @ ${fillPrice}`;
	};

	const summaryParts = [summarizeLeg('LONG'), summarizeLeg('SHORT')].filter(Boolean);

	return {
		title: `Cycle #${cycleNumber} holding`,
		message:
			summaryParts.length > 0
				? `${summaryParts.join(' · ')} · Holding window started.`
				: 'Both legs filled. Holding window started.'
	};
};

export const summarizeCycleSuccessToastLog = (log: LogEntry): CycleToastSummary | null => {
	const match = log.message.match(/^Cycle #(\d+) completed\.$/);
	if (!match) return null;

	const volumeUsd = Number(log.meta?.volumeUsd);
	const feesUsd = Number(log.meta?.feesUsd);
	const gasUsd = Number(log.meta?.gasUsd);
	const detailParts = [
		Number.isFinite(volumeUsd) && volumeUsd > 0 ? `Volume ${currency(volumeUsd, 4)}` : null,
		Number.isFinite(feesUsd) && feesUsd >= 0 ? `Fees ${currency(feesUsd, 4)}` : null,
		Number.isFinite(gasUsd) && gasUsd >= 0 ? `Gas ${currency(gasUsd, 4)}` : null
	].filter(Boolean);

	return {
		title: `Cycle #${match[1]} completed`,
		message:
			detailParts.length > 0
				? detailParts.join(' · ')
				: 'Cycle completed successfully.'
	};
};

export const isCycleScopedLog = (log: LogEntry): boolean => {
	if (typeof log.meta?.cleanupRunId === 'string' && log.meta.cleanupRunId.length > 0) {
		return false;
	}
	if (cycleNumberFromLog(log) !== null) {
		return true;
	}

	const message = log.message.toLowerCase();
	return (
		message.includes(' long ') ||
		message.startsWith('long ') ||
		message.includes(' short ') ||
		message.startsWith('short ') ||
		message.includes('order submitted') ||
		message.includes('waiting for both open orders') ||
		message.includes('entered holding window') ||
		message.includes('close orders filled') ||
		message.includes('repricing partially filled maker order')
	);
};

export const logPhaseKey = (log: LogEntry): LogPhaseGroupKey => {
	const metaPhase = String(log.meta?.phase ?? '').toUpperCase();
	if (metaPhase === 'OPEN' || metaPhase === 'HOLD' || metaPhase === 'CLOSE' || metaPhase === 'GENERAL') {
		return metaPhase;
	}

	const message = log.message.toLowerCase();
	if (
		message.includes('holding window') ||
		message.includes('hold ') ||
		message.includes('entered holding')
	) {
		return 'HOLD';
	}
	if (
		message.includes(' close ') ||
		message.startsWith('close ') ||
		message.includes(' closing') ||
		message.includes('completed.') ||
		message.includes('flatten') ||
		message.includes('forced cleanup')
	) {
		return 'CLOSE';
	}
	if (
		message.includes('starting cycle') ||
		message.includes(' open ') ||
		message.startsWith('open ') ||
		message.includes('waiting for both open orders') ||
		message.includes('repricing partially filled maker order') ||
		message.includes('poll open orders')
	) {
		return 'OPEN';
	}
	return 'GENERAL';
};

export const groupLogsByCycle = (logs: LogEntry[]) => {
	const groups: LogGroup[] = [];
	let currentCycleNumber: number | null = null;

	for (const log of logs) {
		const cleanupRunId = typeof log.meta?.cleanupRunId === 'string' ? log.meta.cleanupRunId : null;
		const explicitCycleNumber = cycleNumberFromLog(log);
		if (explicitCycleNumber !== null) {
			currentCycleNumber = explicitCycleNumber;
		}

		const cycleNumber =
			cleanupRunId ? null : explicitCycleNumber ?? (isCycleScopedLog(log) ? currentCycleNumber : null);
		const key = cleanupRunId
			? `cleanup-${cleanupRunId}`
			: cycleNumber !== null
				? `cycle-${cycleNumber}`
				: 'system';
		let group = groups.find((item) => item.key === key);
		if (!group) {
			group = {
				key,
				label: cleanupRunId ? 'Clean' : cycleNumber !== null ? `Cycle #${cycleNumber}` : 'System',
				cycleNumber,
				kind: cleanupRunId ? 'cleanup' : cycleNumber !== null ? 'cycle' : 'system',
				logs: []
			};
			groups.push(group);
		}

		group.logs.push(log);
	}

	return [...groups].reverse();
};

export const splitLogGroups = (logs: LogEntry[]): LogSplit => {
	const grouped = groupLogsByCycle(logs);
	const rawSystemGroup = grouped.find((group) => group.kind === 'system') ?? null;
	const cleanupGroups = grouped.filter((group) => group.kind === 'cleanup');
	const cycleGroups = grouped.filter((group) => group.kind === 'cycle');

	return {
		systemGroup: rawSystemGroup,
		cleanupGroups,
		cycleGroups
	};
};

export const buildAccountLogData = (
	logs: RuntimeSnapshot['logs'],
	accountKey: BotAccountKey,
	labels: { accountALabel?: string | null; accountBLabel?: string | null } = {}
): LogSplit =>
	splitLogGroups(logs.filter((log) => logAccountKey(log, labels) === accountKey));

export const groupLogsByPhase = (logs: LogEntry[]) => {
	const phaseOrder: LogPhaseGroupKey[] = ['OPEN', 'HOLD', 'CLOSE', 'GENERAL'];
	const labels: Record<LogPhaseGroupKey, string> = {
		OPEN: 'Open',
		HOLD: 'Hold',
		CLOSE: 'Close',
		GENERAL: 'General'
	};

	return phaseOrder
		.map((phase) => ({
			key: phase.toLowerCase(),
			label: labels[phase],
			logs: logs.filter((log) => logPhaseKey(log) === phase)
		}))
		.filter((group) => group.logs.length > 0);
};

export const summarizeLogs = (logs: LogEntry[]): LogSummary[] => {
	const summaries = new Map<string, LogSummary>();

	for (const log of logs) {
		const errorDetail = typeof log.meta?.error === 'string' ? log.meta.error : undefined;
		const displayErrorDetail = normalizeDisplayError(errorDetail);
		const numericQuantity = Number(log.meta?.quantity);
		const quantity =
			Number.isFinite(numericQuantity) && numericQuantity > 0 ? formatAssetAmount(numericQuantity, 'SUI') : null;
		const numericPrice = Number(log.meta?.fillPrice ?? log.meta?.price);
		const price =
			Number.isFinite(numericPrice) && numericPrice > 0 ? currency(numericPrice, 4) : null;
		const numericPnl = Number(log.meta?.cleanupPnlUsd ?? log.meta?.pnlUsd);
		const pnlUsd =
			Number.isFinite(numericPnl) && numericPnl !== 0 ? `PnL ${currency(numericPnl, 4)}` : null;
		const numericGas = Number(log.meta?.cleanupGasUsd ?? log.meta?.gasUsd);
		const gasUsd =
			Number.isFinite(numericGas) && numericGas > 0 ? `Gas ${currency(numericGas, 4)}` : null;
		const numericRecoveryCount = Number(log.meta?.cleanupRecoveryCount);
		const recoveryCount =
			Number.isFinite(numericRecoveryCount) && numericRecoveryCount > 0
				? `${numericRecoveryCount} ${numericRecoveryCount === 1 ? 'recovery' : 'recoveries'}`
				: null;
		const orderId = typeof log.meta?.orderId === 'string' ? log.meta.orderId : null;
		const txDigest = typeof log.meta?.txDigest === 'string' ? log.meta.txDigest : null;
		const detailParts = [
			quantity,
			price ? `@ ${price}` : null,
			orderId ? `Order ${shortHash(orderId)}` : null,
			pnlUsd,
			gasUsd,
			recoveryCount
		].filter(Boolean);
		const detail = detailParts.length > 0 ? detailParts.join(' · ') : displayErrorDetail;
		const key = `${log.level}:${log.message}:${detail ?? ''}:${txDigest ?? ''}`;
		const attempt = Number(log.meta?.attempt);

		if (!summaries.has(key)) {
			summaries.set(key, {
				key,
				message: log.message,
				level: log.level,
				logs: [],
				latestAt: log.createdAt,
				attempts: [],
				detail,
				txDigest: txDigest ?? undefined,
				isFatal: errorDetail ? isFatalLogMessage(errorDetail) : false,
				phase: logPhaseKey(log)
			});
		}

		const summary = summaries.get(key)!;
		summary.logs.push(log);
		summary.latestAt = log.createdAt;
		if (Number.isFinite(attempt) && attempt > 0 && !summary.attempts.includes(attempt)) {
			summary.attempts.push(attempt);
		}
		if (!summary.detail && detail) {
			summary.detail = detail;
		}
		if (txDigest) {
			summary.txDigest = txDigest;
		}
		if (errorDetail && isFatalLogMessage(errorDetail)) {
			summary.isFatal = true;
		}
	}

	return [...summaries.values()].sort(
		(left, right) => new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime()
	);
};

export const summarizeLogsByPhase = (logs: LogEntry[]): PhaseSummary[] =>
	summarizeLogs(logs).map((summary) => ({
			...summary,
			phaseKey: summary.phase ?? 'GENERAL',
			phaseLabel:
				summary.phase === 'OPEN'
					? 'Open'
					: summary.phase === 'HOLD'
						? 'Hold'
						: summary.phase === 'CLOSE'
							? 'Close'
							: 'General'
		}));

export const orderSummaryLabel = (
	order: RuntimeSnapshot['history'][number]['orders'][number],
	accountALabel = 'Account A',
	accountBLabel = 'Account B'
) =>
	`${order.account === 'accountA' ? accountALabel : accountBLabel} ${order.side.toLowerCase()}`;

export const orderAccountLabel = (account: 'accountA' | 'accountB', accountALabel = 'Account A', accountBLabel = 'Account B') =>
	account === 'accountA' ? accountALabel : accountBLabel;

export const orderDisplayPrice = (order: RuntimeSnapshot['history'][number]['orders'][number]) =>
	order.filledPrice ?? order.price;
export const orderDisplayQuantity = (order: RuntimeSnapshot['history'][number]['orders'][number]) =>
	order.filledQuantity ?? order.quantity;

export const ordersForPhase = (
	orders: RuntimeSnapshot['history'][number]['orders'],
	phase: BotOrderPhase
) => orders.filter((order) => order.phase === phase);

export const logDotClass = (level: LogEntry['level']): string => {
	if (level === 'info') return 'bg-sky-400';
	if (level === 'success') return 'bg-emerald-400';
	if (level === 'warn') return 'bg-amber-400';
	if (level === 'error') return 'bg-rose-400';
	return 'bg-slate-400';
};

export const logSummaryClass = (summary: LogSummary): string => {
	if (summary.isFatal) {
		return 'border-error/40 bg-error/8';
	}
	if (summary.level === 'success') {
		return 'border-success/25 bg-base-200';
	}
	if (summary.level === 'error') {
		return 'border-error/25 bg-base-200';
	}
	if (summary.level === 'warn') {
		return 'border-warning/25 bg-base-200';
	}
	if (summary.level === 'info') {
		return 'border-info/15 bg-base-200';
	}
	return 'border-base-300 bg-base-200';
};

export const phaseBadgeClass = (phase: LogPhaseGroupKey): string => {
	if (phase === 'OPEN') return 'badge-info';
	if (phase === 'HOLD') return 'badge-success';
	if (phase === 'CLOSE') return 'badge-warning';
	return 'badge-ghost';
};
