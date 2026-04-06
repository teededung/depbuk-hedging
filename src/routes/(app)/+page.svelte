<script lang="ts">
	import { browser } from '$app/environment';
	import { tick } from 'svelte';
	import QRCode from 'qrcode';
	import { toast } from 'svelte-daisy-toaster';

	import type { BotAccountKey, RuntimeSnapshot } from '$lib/types/bot.js';
	import type { PageData } from './$types.js';
	import {
		buildSettingsValidationErrors,
		createBlankSettingsErrors,
		buildAccountLogData,
		clonePreflight,
		createBlankSettingsForm,
		formatClock,
		pct,
		summarizeHoldingToastLog,
		summarizeCycleSuccessToastLog,
		toSettingsForm,
		type SettingsFormErrors,
		type SettingsForm
	} from './_helpers/page-view.js';
	import {
		fetchBotControl,
		fetchNotionalMaxPreview,
		fetchBotSettings,
		fetchBotStatus,
		saveBotSettings,
		swapBotSettings
	} from './_helpers/page-controller.js';
	import { createSnapshotDefaults } from '$lib/runtime-snapshot-defaults.js';
	import BalanceOverviewCard from './_components/BalanceOverviewCard.svelte';
	import ConfirmActionModal from './_components/ConfirmActionModal.svelte';
	import CycleHistoryCard from './_components/CycleHistoryCard.svelte';
	import DashboardTopbar from './_components/DashboardTopbar.svelte';
	import DepositModal from './_components/DepositModal.svelte';
	import HeroMetrics from './_components/HeroMetrics.svelte';
	import RuntimeFeedPanel from './_components/RuntimeFeedPanel.svelte';
	import SettingsModal from './_components/SettingsModal.svelte';
	import AutoBalanceModal from './_components/AutoBalanceModal.svelte';

	type RuntimeDialogMode = 'start' | 'clean' | 'swap' | null;
	type Props = { data: PageData };

	let { data }: Props = $props();

	const createBlankSnapshot = (): RuntimeSnapshot => ({
		...createSnapshotDefaults(new Date(0).toISOString()),
		message: 'Loading runtime snapshot.',
	});

	let snapshot = $state<RuntimeSnapshot>(createBlankSnapshot());
	let controlPending = $state(false);
	let preflightPending = $state(false);
	let preflightError = $state<string | null>(null);
	let streamError = $state(false);
	let now = $state(Date.now());
	let depositModalOpen = $state(false);
	let confirmModalOpen = $state(false);
	let settingsModalOpen = $state(false);
	let autoBalanceModalOpen = $state(false);
	let promptMode = $state<RuntimeDialogMode>(null);
	let modalPreflight = $state<RuntimeSnapshot['preflight']>(clonePreflight(createBlankSnapshot().preflight));
	let accountAOpenCycleKey = $state<string | null>(null);
	let accountBOpenCycleKey = $state<string | null>(null);
	let latestAccountACycleKey = $state<string | null>(null);
	let latestAccountBCycleKey = $state<string | null>(null);
	let depositTarget = $state<'accountA' | 'accountB'>('accountA');
	let depositQr = $state('');
	let copySucceeded = $state(false);
	let copyResetTimer = $state<number | null>(null);
	let settingsForm = $state<SettingsForm>(createBlankSettingsForm());
	let settingsPending = $state(false);
	let settingsSaving = $state(false);
	let settingsError = $state<string | null>(null);
	let settingsSuccess = $state<string | null>(null);
	let seenLogIds = $state<Set<number>>(new Set());
	let startPending = $state(false);
	let settingsErrors = $state<SettingsFormErrors>(createBlankSettingsErrors());

	const priceRefreshIntervalMs = 10000;
	const accountALabel = $derived.by(
		() => snapshot.config?.accountALabel ?? snapshot.preflight.accountA.label ?? 'Account A (Long)'
	);
	const accountBLabel = $derived.by(
		() => snapshot.config?.accountBLabel ?? snapshot.preflight.accountB.label ?? 'Account B (Short)'
	);
	const logAccountLabels = $derived.by(() => ({
		accountALabel,
		accountBLabel
	}));

	const activeCycleElapsed = $derived.by(() => {
		if (!snapshot.activeCycle?.holdStartedAt) return 0;
		return Math.max(
			0,
			Math.floor((now - new Date(snapshot.activeCycle.holdStartedAt).getTime()) / 1000)
		);
	});
	const activeCycleProgress = $derived.by(() =>
		pct(activeCycleElapsed, snapshot.activeCycle?.holdSecondsTarget ?? 0)
	);
	const activeCycleLabel = $derived.by(() => {
		if (!snapshot.activeCycle) {
			if (snapshot.lifecycle === 'BOOTING') return 'Booting';
			return startPending ? 'Starting...' : 'Awaiting next cycle';
		}
		if (snapshot.activeCycle.stage === 'holding') {
			return `Holding: ${formatClock(activeCycleElapsed)}`;
		}
		return snapshot.activeCycle.stage.replace('_', ' ');
	});
	const priceRefreshElapsedMs = $derived.by(() =>
		Math.max(0, now - new Date(snapshot.price.updatedAt).getTime())
	);
	const priceRefreshProgress = $derived.by(() =>
		pct(priceRefreshElapsedMs, priceRefreshIntervalMs)
	);
	const priceRingRadius = 14;
	const priceRingCircumference = 2 * Math.PI * priceRingRadius;
	const priceRingOffset = $derived.by(
		() => priceRingCircumference * (1 - priceRefreshProgress / 100)
	);

	const depositAccount = $derived.by(() => snapshot.balances[depositTarget]);
	const depositLabel = $derived.by(() =>
		depositTarget === 'accountA' ? accountALabel : accountBLabel
	);
	const preflightAccounts = $derived.by(() => [
		{
			key: 'accountA' as const,
			status: modalPreflight.accountA,
			address: snapshot.balances.accountA.address
		},
		{
			key: 'accountB' as const,
			status: modalPreflight.accountB,
			address: snapshot.balances.accountB.address
		}
	]);
	const startBlocked = $derived.by(
		() => promptMode === 'start' && (preflightPending || !!preflightError || !modalPreflight.ready)
	);

	const accountALogData = $derived.by(() =>
		buildAccountLogData(snapshot.logs, 'accountA', logAccountLabels)
	);
	const accountBLogData = $derived.by(() =>
		buildAccountLogData(snapshot.logs, 'accountB', logAccountLabels)
	);

	const handleCycleToggle = (
		scope: 'accountA' | 'accountB',
		key: string,
		target: EventTarget | null
	) => {
		const isOpen = (target as HTMLDetailsElement | null)?.open ?? false;
		if (scope === 'accountA') {
			accountAOpenCycleKey = isOpen
				? key
				: accountAOpenCycleKey === key
					? null
					: accountAOpenCycleKey;
			return;
		}
		accountBOpenCycleKey = isOpen
			? key
			: accountBOpenCycleKey === key
				? null
				: accountBOpenCycleKey;
	};

	async function sendControl(action: 'start' | 'stop' | 'stop-clean'): Promise<RuntimeSnapshot> {
		controlPending = true;
		startPending = action === 'start';
		try {
			const nextSnapshot = await fetchBotControl(action);
			handleIncomingSnapshot(nextSnapshot);
			if (action === 'start') {
				toast.info({
					title: 'Start queued',
					message:
						nextSnapshot.message || 'Cycle queue has been created and the bot is preparing to run.',
					durationMs: 2400
				});
			} else if (action === 'stop') {
				toast.info({
					title: 'Stop requested',
					message:
						nextSnapshot.message || 'The bot is stopping and flattening positions if needed.',
					durationMs: 2600
				});
			} else {
				toast.info({
					title: 'Clean started',
					message: nextSnapshot.message || 'Runtime logs were cleared and cleanup has started.',
					durationMs: 2600
				});
			}
			return nextSnapshot;
		} catch (error) {
			if (action === 'start') {
				startPending = false;
			}
			const message = error instanceof Error ? error.message : 'Bot control request failed.';
			toast.error({
				title: 'Action failed',
				message,
				durationMs: 4200
			});
			return snapshot;
		} finally {
			controlPending = false;
		}
	}

	async function refreshStatusSnapshot(readiness = false): Promise<RuntimeSnapshot> {
		const nextSnapshot = await fetchBotStatus(readiness);
		handleIncomingSnapshot(nextSnapshot);
		return nextSnapshot;
	}

	async function openStartModal(): Promise<void> {
		if (controlPending || preflightPending) return;
		promptMode = 'start';
		preflightPending = true;
		preflightError = null;
		modalPreflight = clonePreflight(createBlankSnapshot().preflight);
		confirmModalOpen = true;
		await tick();
		try {
			const nextSnapshot = await refreshStatusSnapshot(true);
			modalPreflight = clonePreflight(nextSnapshot.preflight);
		} catch (error) {
			preflightError =
				error instanceof Error ? error.message : 'Failed to inspect wallet readiness before start.';
			toast.error({
				title: 'Preflight failed',
				message: preflightError,
				durationMs: 4200
			});
		} finally {
			preflightPending = false;
		}
	}

	function openCleanModal(): void {
		if (controlPending || preflightPending) return;
		promptMode = 'clean';
		preflightError = null;
		confirmModalOpen = true;
	}

	function openSwapModal(): void {
		if (controlPending || preflightPending) return;
		promptMode = 'swap';
		preflightError = null;
		confirmModalOpen = true;
	}

	function closeConfirmModal(): void {
		confirmModalOpen = false;
		if (!controlPending) {
			promptMode = null;
		}
	}

	function resetSettingsErrors(): void {
		settingsErrors = createBlankSettingsErrors();
	}

	function validateSettingsForm(): boolean {
		settingsErrors = buildSettingsValidationErrors(settingsForm);
		return Object.values(settingsErrors).every((error) => !error);
	}

	async function loadSettings(): Promise<void> {
		settingsPending = true;
		settingsError = null;
		settingsSuccess = null;
		resetSettingsErrors();
		try {
			const payload = await fetchBotSettings();
			settingsForm = toSettingsForm(payload.settings);
			handleIncomingSnapshot(payload.snapshot);
		} catch (error) {
			settingsError = error instanceof Error ? error.message : 'Failed to load settings.';
			toast.error({
				title: 'Could not load settings',
				message: settingsError,
				durationMs: 4200
			});
		} finally {
			settingsPending = false;
		}
	}

	async function openSettingsModal(): Promise<void> {
		if (settingsSaving) return;
		settingsModalOpen = true;
		await tick();
		await loadSettings();
	}

	function closeSettingsModal(): void {
		settingsModalOpen = false;
	}

	async function saveSettings(): Promise<void> {
		if (settingsSaving || !validateSettingsForm()) {
			return;
		}

		settingsSaving = true;
		settingsError = null;
		settingsSuccess = null;
		try {
			const payload = await saveBotSettings(settingsForm);
			settingsForm = toSettingsForm(payload.settings);
			handleIncomingSnapshot(payload.snapshot);
			settingsSuccess = snapshot.config?.settingsApplyPending
				? 'Settings saved. Restart bot to apply changes.'
				: 'Settings saved.';
			toast.success({
				title: 'Settings saved',
				message: settingsSuccess,
				durationMs: 2600
			});
		} catch (error) {
			settingsError = error instanceof Error ? error.message : 'Failed to save settings.';
			toast.error({
				title: 'Could not save settings',
				message: settingsError,
				durationMs: 4200
			});
		} finally {
			settingsSaving = false;
		}
	}

	async function applyMaxNotional(): Promise<void> {
		if (settingsPending || settingsSaving) return;

		try {
			const { preview } = await fetchNotionalMaxPreview();
			settingsForm.notional_size_usd = preview.recommendedNotionalUsd;
			settingsError = null;
			settingsSuccess = `Notional set to $${preview.recommendedNotionalUsd.toFixed(1)} (safe max $${preview.maxAffordableNotionalUsd.toFixed(1)}, ${preview.headroomPercent}% headroom).`;
			toast.success({
				title: 'Notional Max Applied',
				message: settingsSuccess,
				durationMs: 3200
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Failed to estimate max notional from current balances.';
			settingsError = message;
			toast.error({
				title: 'Max notional unavailable',
				message,
				durationMs: 4200
			});
			throw new Error(message);
		}
	}

	async function confirmPrompt(): Promise<void> {
		const mode = promptMode;
		if (mode === 'start' && !modalPreflight.ready) {
			return;
		}
		confirmModalOpen = false;
		promptMode = null;
		if (mode === 'start') {
			await sendControl('start');
			return;
		}
		if (mode === 'clean') {
			await sendControl('stop-clean');
			return;
		}
		if (mode === 'swap') {
			controlPending = true;
			try {
				const { snapshot: nextSnapshot } = await swapBotSettings();
				handleIncomingSnapshot(nextSnapshot);
				toast.success({ title: 'Swapped', message: nextSnapshot.message, durationMs: 2600 });
			} catch (error) {
				toast.error({ title: 'Swap Failed', message: error instanceof Error ? error.message : 'Failed to swap accounts', durationMs: 4200 });
			} finally {
				controlPending = false;
			}
		}
	}

	async function refreshDepositQr(accountKey: 'accountA' | 'accountB'): Promise<void> {
		const address = snapshot.balances[accountKey].address;
		if (!browser || !address) {
			depositQr = '';
			return;
		}

		depositQr = await QRCode.toDataURL(address, {
			width: 240,
			margin: 1,
			color: {
				dark: '#e2e8f0',
				light: '#081121'
			}
		});
	}

	async function openDepositModal(accountKey: BotAccountKey): Promise<void> {
		depositTarget = accountKey;
		copySucceeded = false;
		if (copyResetTimer) {
			clearTimeout(copyResetTimer);
			copyResetTimer = null;
		}
		depositModalOpen = true;
		await tick();
		await refreshDepositQr(accountKey);
	}

	function closeDepositModal(): void {
		depositModalOpen = false;
	}

	async function switchDepositTarget(accountKey: BotAccountKey): Promise<void> {
		depositTarget = accountKey;
		copySucceeded = false;
		if (copyResetTimer) {
			clearTimeout(copyResetTimer);
			copyResetTimer = null;
		}
		await refreshDepositQr(accountKey);
	}

	async function copyDepositAddress(): Promise<void> {
		const address = depositAccount.address;
		if (!browser || !address) {
			copySucceeded = false;
			return;
		}
		try {
			await navigator.clipboard.writeText(address);
			copySucceeded = true;
			toast.success({
				title: 'Address copied',
				message: `${depositLabel} address copied to clipboard.`,
				durationMs: 1800
			});
			if (copyResetTimer) {
				clearTimeout(copyResetTimer);
			}
			copyResetTimer = window.setTimeout(() => {
				copySucceeded = false;
				copyResetTimer = null;
			}, 1600);
		} catch {
			copySucceeded = false;
			toast.error({
				title: 'Copy failed',
				message: 'Could not copy the wallet address to clipboard.',
				durationMs: 3000
			});
		}
	}

	function handleIncomingSnapshot(
		nextSnapshot: RuntimeSnapshot,
		options: { live?: boolean } = {}
	): void {
		if (nextSnapshot.activeCycle || nextSnapshot.lifecycle !== 'RUNNING') {
			startPending = false;
		}

		if (options.live) {
			for (const log of nextSnapshot.logs) {
				if (seenLogIds.has(log.id)) continue;
				seenLogIds.add(log.id);
				const holdingToast = summarizeHoldingToastLog(log, nextSnapshot.logs);
				if (holdingToast) {
					toast.success({
						title: holdingToast.title,
						message: holdingToast.message,
						durationMs: 4200
					});
					continue;
				}
				const cycleToast = summarizeCycleSuccessToastLog(log);
				if (cycleToast) {
					toast.success({
						title: cycleToast.title,
						message: cycleToast.message,
						durationMs: 4200
					});
					continue;
				}
			}
		} else {
			seenLogIds = new Set(nextSnapshot.logs.map((log) => log.id));
		}

		snapshot = nextSnapshot;
	}

	$effect(() => {
		handleIncomingSnapshot(structuredClone(data.snapshot));
	});

	$effect(() => {
		const latestKey = accountALogData.cycleGroups[0]?.key ?? null;
		if (!latestKey) {
			accountAOpenCycleKey = null;
			latestAccountACycleKey = null;
			return;
		}
		if (latestKey !== latestAccountACycleKey) {
			accountAOpenCycleKey = latestKey;
			latestAccountACycleKey = latestKey;
		}
	});

	$effect(() => {
		const latestKey = accountBLogData.cycleGroups[0]?.key ?? null;
		if (!latestKey) {
			accountBOpenCycleKey = null;
			latestAccountBCycleKey = null;
			return;
		}
		if (latestKey !== latestAccountBCycleKey) {
			accountBOpenCycleKey = latestKey;
			latestAccountBCycleKey = latestKey;
		}
	});

	$effect(() => {
		if (!browser) return;
		const interval = window.setInterval(() => {
			now = Date.now();
		}, 100);
		const stream = new EventSource('/api/bot/stream');
		stream.onmessage = (event) => {
			streamError = false;
			handleIncomingSnapshot(JSON.parse(event.data) as RuntimeSnapshot, { live: true });
		};
		stream.onerror = () => {
			streamError = true;
		};
		return () => {
			window.clearInterval(interval);
			stream.close();
		};
	});
</script>

<svelte:head>
	<title>SUI Hedging Dashboard</title>
	<meta
		name="description"
		content="Automated hedging dashboard for paired long and short cycles on Sui."
	/>
</svelte:head>

<div class="dashboard-shell">
	<div class="relative z-10 space-y-6">
		<DashboardTopbar
			{snapshot}
			{activeCycleLabel}
			{activeCycleProgress}
			onOpenSettings={openSettingsModal}
			onOpenStart={openStartModal}
			onClean={openCleanModal}
			{settingsPending}
			{settingsSaving}
			{controlPending}
			{preflightPending}
		/>

		<HeroMetrics
			{snapshot}
			{accountALabel}
			{accountBLabel}
			{streamError}
			{priceRingCircumference}
			{priceRingOffset}
		/>

		<div class="grid gap-6 lg:grid-cols-2">
			<BalanceOverviewCard
				{snapshot}
				{accountALabel}
				{accountBLabel}
				onOpenDeposit={openDepositModal}
				onOpenAutoBalance={() => {
					autoBalanceModalOpen = true;
				}}
				onOpenSwapConfirmation={openSwapModal}
			/>
			<CycleHistoryCard {snapshot} {accountALabel} {accountBLabel} />
		</div>

		<RuntimeFeedPanel
			{snapshot}
			openAccountACycleKey={accountAOpenCycleKey}
			openAccountBCycleKey={accountBOpenCycleKey}
			onCycleToggle={handleCycleToggle}
		/>
	</div>

	<SettingsModal
		open={settingsModalOpen}
		onClose={closeSettingsModal}
		{snapshot}
		{settingsPending}
		{settingsSaving}
		{settingsError}
		{settingsSuccess}
		{settingsErrors}
		bind:settingsForm
		onSave={saveSettings}
		onApplyNotionalMax={applyMaxNotional}
	/>

	<DepositModal
		open={depositModalOpen}
		onClose={closeDepositModal}
		{depositQr}
		{depositTarget}
		{snapshot}
		{copySucceeded}
		{depositLabel}
		onSwitchTarget={switchDepositTarget}
		onCopyAddress={copyDepositAddress}
	/>

	<ConfirmActionModal
		open={confirmModalOpen}
		onClose={closeConfirmModal}
		{promptMode}
		{preflightPending}
		{modalPreflight}
		{preflightError}
		{preflightAccounts}
		{snapshot}
		{controlPending}
		{startBlocked}
		onConfirm={confirmPrompt}
	/>

	<AutoBalanceModal
		open={autoBalanceModalOpen}
		savedMaxCycles={settingsForm.max_cycles}
		onClose={() => {
			autoBalanceModalOpen = false;
		}}
		onExecuted={(next) => {
			handleIncomingSnapshot(next);
		}}
	/>
</div>
