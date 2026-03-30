<script lang="ts">
	import type { RuntimeSnapshot } from '$lib/types/bot.js';

	type Props = {
		snapshot: RuntimeSnapshot;
		activeCycleLabel?: string;
		activeCycleProgress?: number;
		onOpenSettings: () => void;
		onOpenStart: () => void;
		onClean: () => void;
		settingsPending: boolean;
		settingsSaving: boolean;
		controlPending: boolean;
		preflightPending: boolean;
	};

	let {
		snapshot,
		activeCycleLabel,
		activeCycleProgress,
		onOpenSettings,
		onOpenStart,
		onClean,
		settingsPending,
		settingsSaving,
		controlPending,
		preflightPending
	}: Props = $props();

	const showStartButton = $derived.by(
		() => snapshot.lifecycle === 'STOPPED' || snapshot.lifecycle === 'CONFIG_REQUIRED'
	);
	const resolvedActiveCycleLabel = $derived.by(
		() =>
			activeCycleLabel ??
			(snapshot.activeCycle ? snapshot.activeCycle.stage.replace('_', ' ') : 'Awaiting next cycle')
	);
	const progressValue = $derived.by(() =>
		Math.max(0, Math.min(100, activeCycleProgress ?? 0))
	);
	const progressHeadLeft = $derived.by(() => {
		if (progressValue <= 1) return '0.25rem';
		return `min(calc(${progressValue}% - 0.375rem), calc(100% - 0.75rem))`;
	});
	const activeCycleHeadline = $derived.by(() => {
		if (snapshot.activeCycle) {
			return `#${snapshot.activeCycle.cycleNumber}`;
		}
		return snapshot.lifecycle === 'BOOTING' ? 'Booting' : 'Idle';
	});
	const activeCycleSubline = $derived.by(() => {
		if (snapshot.activeCycle) {
			return `@ ${snapshot.activeCycle.price.toFixed(4)} USDC`;
		}
		return snapshot.lifecycle === 'BOOTING' ? 'Preparing runtime' : 'Awaiting next cycle';
	});
	const cycleCounterLabel = $derived.by(() => {
		const currentCycle = Math.max(0, snapshot.runCycleCount ?? 0);
		const maxCycles = snapshot.config?.maxCycles;
		if (typeof maxCycles === 'number' && Number.isFinite(maxCycles) && maxCycles > 0) {
			return `${Math.min(currentCycle, maxCycles)}/${maxCycles}`;
		}
		return `${currentCycle}/∞`;
	});
</script>

<header
	class="rounded-3xl border border-base-300/70 bg-base-200/70 px-4 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur md:px-5"
>
	<div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
		<div class="flex items-center gap-4 lg:min-w-[20rem]">
			<div
				class="relative grid h-12 w-12 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary shadow-inner shadow-primary/10"
			>
				<span
					class="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/25 via-transparent to-secondary/15 blur-md"
				></span>
				<span class="relative text-xl">↯</span>
			</div>

			<div class="space-y-1">
				<div class="flex flex-wrap items-center gap-2">
					<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-base-content/60">
						Live trading desk
					</p>
					<span class="inline-flex items-center gap-2 rounded-full border border-base-300 bg-base-100/60 px-3 py-1 text-xs font-medium text-base-content/75">
						<span class="h-2 w-2 rounded-full bg-success shadow-[0_0_0_4px_rgba(34,197,94,0.16)]"></span>
						{snapshot.liveLabel}
					</span>
				</div>
				<h1 class="text-lg font-semibold tracking-tight text-base-content md:text-xl">
					SUI Hedging Dashboard
				</h1>
				<p class="text-sm text-base-content/60">{activeCycleHeadline} · {activeCycleSubline}</p>
			</div>
		</div>

		<div class="w-full lg:flex-1 lg:px-2">
			<div class="rounded-2xl border border-base-300/70 bg-base-100/45 p-3">
				<div class="mb-2 flex items-center justify-between gap-3 text-sm">
					<span class="text-base-content/75">{resolvedActiveCycleLabel}</span>
					<div class="flex items-center gap-3">
						<span class="tabular-nums text-xs font-medium text-base-content/55">{cycleCounterLabel}</span>
						<span class="tabular-nums text-base-content/60">{Math.round(progressValue)}%</span>
					</div>
				</div>
				<div class="relative h-2.5 w-full overflow-hidden rounded-full bg-base-300/90">
					<div
						class="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-cyan-400 via-primary to-cyan-300 transition-[width] duration-300 ease-linear"
						style={`width: ${progressValue}%;`}
					></div>
					{#if snapshot.activeCycle && progressValue > 0}
						<div
							class="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.72)] transition-[left] duration-300 ease-linear"
							style={`left: ${progressHeadLeft};`}
						></div>
					{/if}
				</div>
			</div>
		</div>

		<div
			class="flex flex-wrap items-center justify-end gap-2 rounded-2xl border border-base-300/70 bg-base-100/40 p-2 lg:shrink-0"
		>
			<button class="btn btn-sm btn-ghost" onclick={onOpenSettings} disabled={settingsSaving}>
				Settings
			</button>

			{#if showStartButton}
				<button
					class="btn btn-sm btn-success"
					onclick={onOpenStart}
					disabled={controlPending || preflightPending}
				>
					{preflightPending ? 'Checking...' : controlPending ? 'Starting...' : 'Start Bot'}
				</button>
			{/if}

			<button class="btn btn-sm btn-outline" onclick={onClean} disabled={controlPending}>
				{controlPending ? 'Stopping & Cleaning...' : 'Stop & Clean'}
			</button>
		</div>
	</div>
</header>
