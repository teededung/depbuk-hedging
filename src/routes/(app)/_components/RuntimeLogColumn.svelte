<script lang="ts">
	import type { LogSplit } from '../_helpers/page-view.js';
	import RuntimeLogSummaryRow from './RuntimeLogSummaryRow.svelte';
	import { phaseBadgeClass, summarizeLogsByPhase } from '../_helpers/page-view.js';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';

	type Props = {
		title: string;
		accountAddress: string;
		logData: LogSplit;
		openCycleKey: string | null;
		onCycleToggle: (scope: 'accountA' | 'accountB', key: string, target: EventTarget | null) => void;
		scope: 'accountA' | 'accountB';
		network?: 'mainnet' | 'testnet';
	};

	let {
		title,
		accountAddress,
		logData,
		openCycleKey,
		onCycleToggle,
		scope,
		network = 'mainnet'
	}: Props = $props();

	const summarizeByPhase = (phaseLogs: LogSplit['cycleGroups'][number]['logs']) => summarizeLogsByPhase(phaseLogs);
	const groupLatestAt = (group: LogSplit['cycleGroups'][number]) =>
		group.logs[group.logs.length - 1]?.createdAt ?? group.logs[0]?.createdAt ?? '';
	const displayCycleGroups = $derived.by(() => {
		const grouped = [
			...logData.cycleGroups,
			...logData.cleanupGroups,
			...(logData.systemGroup ? [logData.systemGroup] : [])
		];
		return grouped
			.sort(
				(left, right) =>
					new Date(groupLatestAt(right)).getTime() - new Date(groupLatestAt(left)).getTime()
			)
			.slice(0, 3);
	});
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between gap-2">
		<strong>{title}</strong>
		<span class="text-xs text-base-content/65">{accountAddress}</span>
	</div>

	{#if displayCycleGroups.length === 0 && !logData.systemGroup}
		<div class="rounded-2xl border border-dashed border-base-300 bg-base-100 p-5 text-sm text-base-content/70">No logs recorded.</div>
	{:else}
		{#each displayCycleGroups as group (group.key)}
			<details
				class="collapse collapse-arrow rounded-2xl border border-base-300 bg-base-100 shadow-sm"
				open={group.key === openCycleKey}
				ontoggle={(event) => onCycleToggle(scope, group.key, event.currentTarget)}
			>
				<summary class="collapse-title min-h-0">
					<div class="flex items-center justify-between gap-4">
						<span>{group.label}</span>
						<span class="text-xs text-base-content/65">{group.logs.length} logs</span>
					</div>
				</summary>
				<div class="collapse-content px-0">
					<div class="space-y-3 px-4 pb-4">
						{#each summarizeByPhase(group.logs) as summary, index (summary.key)}
							<div animate:flip={{ duration: 240, easing: cubicOut }}>
								<RuntimeLogSummaryRow
									summary={summary}
									showPhase={true}
									phaseClass={phaseBadgeClass(summary.phaseKey)}
									phaseLabel={summary.phaseLabel}
									isNewest={index === 0}
									network={network}
								/>
							</div>
						{/each}
					</div>
				</div>
			</details>
		{/each}
	{/if}
</div>
