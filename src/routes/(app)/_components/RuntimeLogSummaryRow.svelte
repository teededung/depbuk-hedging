<script lang="ts">
	import {
		formatDateTime,
		hasNoOnChainExecution,
		isRetryableSubmissionWarning,
		logSummaryClass,
		parseHighlightedLabelMessage,
		shortHash,
		suiscanTxUrl,
		type LogSummary
	} from '../_helpers/page-view.js';
	import { fly } from 'svelte/transition';

	type Props = {
		summary: LogSummary;
		showPhase: boolean;
		phaseClass?: string;
		phaseLabel?: string;
		isNewest?: boolean;
		network?: 'mainnet' | 'testnet';
	};

	let {
		summary,
		showPhase,
		phaseClass = '',
		phaseLabel = '',
		isNewest = false,
		network = 'mainnet'
	}: Props = $props();
	const levelBadgeClass = () =>
		summary.level === 'success'
			? 'badge-success badge-soft'
			: summary.level === 'error'
			? 'badge-error badge-soft'
			: summary.level === 'warn'
				? 'badge-warning badge-soft'
				: summary.level === 'info'
					? 'badge-info badge-soft'
					: 'badge-ghost';
	const levelStatusClass = () =>
		summary.level === 'success'
			? 'status-success'
			: summary.level === 'error'
				? 'status-error'
				: summary.level === 'warn'
					? 'status-warning'
				: 'status-info';
	const highlightedLabelParts = $derived.by(() =>
		parseHighlightedLabelMessage(
			summary.message,
			summary.logs.find((log) => typeof log.meta?.account === 'string')?.meta.account as
				| string
				| undefined
		)
	);
	const showRetryingBadge = $derived.by(() => isNewest && isRetryableSubmissionWarning(summary));
</script>

<div
	class={`relative rounded-2xl border p-4 ${logSummaryClass(summary)} ${showRetryingBadge ? 'pb-8' : ''}`}
	in:fly={{ y: -12, duration: 320, opacity: 0 }}
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2.5">
				{#if showPhase && phaseLabel}
					<span class={`badge badge-sm font-medium ${phaseClass}`}>{phaseLabel}</span>
				{/if}
				{#if isNewest}
					<div class="inline-grid *:[grid-area:1/1]">
						<div class={`status animate-ping ${levelStatusClass()}`}></div>
						<div class={`status ${levelStatusClass()}`}></div>
					</div>
				{/if}
				{#if summary.level === 'success'}
					<span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-success/15 text-success">
						<svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
							<path
								d="M5 10.5 8.2 13.5 15 6.5"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</span>
				{/if}
				<span class={`badge badge-sm ${levelBadgeClass()}`}>{summary.level}</span>
				<span class="font-medium text-sm leading-6">
					{#if highlightedLabelParts}
						{highlightedLabelParts.prefix}
						<span class="text-primary">{highlightedLabelParts.label}</span>
						{highlightedLabelParts.suffix}
					{:else}
						{summary.message}
					{/if}
				</span>
				{#if summary.logs.length > 1}
					<span class="badge badge-sm badge-outline">{summary.logs.length} events</span>
				{/if}
				{#if summary.attempts.length > 0}
					<span class="badge badge-sm badge-outline">Attempts {summary.attempts.join(', ')}</span>
				{/if}
				{#if summary.isFatal}
					<span class="badge badge-sm badge-error badge-outline">Fatal</span>
				{/if}
				{#if hasNoOnChainExecution(summary)}
					<span class="badge badge-sm badge-outline">No on-chain execution</span>
				{/if}
			</div>
			{#if summary.detail || summary.txDigest}
				<div class="mt-3 flex items-start gap-3 text-sm text-base-content/65">
					{#if summary.detail}
						<span class="min-w-0 flex-1 break-all">{summary.detail}</span>
					{/if}
					{#if summary.txDigest}
						<a
							href={suiscanTxUrl(summary.txDigest, network)}
							target="_blank"
							rel="noreferrer"
							class="link link-hover shrink-0 whitespace-nowrap text-info"
						>
							Tx {shortHash(summary.txDigest)}
						</a>
					{/if}
				</div>
			{/if}
		</div>
		<span class="shrink-0 pt-0.5 text-xs text-base-content/50">{formatDateTime(summary.latestAt)}</span>
	</div>
	{#if showRetryingBadge}
		<div
			class="badge badge-sm badge-warning badge-soft absolute right-4 bottom-3 gap-1.5 border border-warning/20 text-[11px] font-medium"
		>
			<span class="loading loading-spinner loading-xs"></span>
			retrying
		</div>
	{/if}
</div>
