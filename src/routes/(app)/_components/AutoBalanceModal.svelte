<script lang="ts">
	import type { AutoBalancePreview, RuntimeSnapshot } from '$lib/types/bot.js';
	import { toast } from 'svelte-daisy-toaster';
	import { currency, formatAssetAmount } from '../_helpers/page-view.js';
	import AppModal from './AppModal.svelte';

	type Props = {
		open: boolean;
		onClose: () => void;
		onExecuted: (snapshot: RuntimeSnapshot) => void;
		savedMaxCycles?: number | null;
	};

	let { open, onClose, onExecuted, savedMaxCycles = null }: Props = $props();

	const defaultCycles = $derived(savedMaxCycles && savedMaxCycles > 0 ? savedMaxCycles : 2);
	let targetCycles = $state(2);
	let preview = $state<AutoBalancePreview | null>(null);
	let previewPending = $state(false);
	let previewError = $state<string | null>(null);
	let executePending = $state(false);
	let executeError = $state<string | null>(null);
	let executeSuccess = $state<string | null>(null);

	const canConfirm = $derived.by(
		() => preview?.canExecute === true && !executePending && !previewPending
	);
	const anyPlanned = $derived.by(() =>
		preview ? preview.accountA.state === 'planned' || preview.accountB.state === 'planned' : false
	);

	function apiErrorMessage(payload: unknown, fallback: string): string {
		if (typeof payload !== 'object' || payload === null) {
			return fallback;
		}
		const data = payload as Record<string, unknown>;
		const errorMessage =
			typeof data.error === 'string' && data.error.trim().length > 0 ? data.error : fallback;
		const aggregatorContext =
			typeof data.aggregatorContext === 'string' && data.aggregatorContext.trim().length > 0
				? data.aggregatorContext
				: null;
		return aggregatorContext ? `${errorMessage}\n${aggregatorContext}` : errorMessage;
	}

	async function loadPreview(): Promise<void> {
		previewPending = true;
		previewError = null;
		executeError = null;
		executeSuccess = null;
		preview = null;
		try {
			const res = await fetch('/api/bot/balance', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'preview', targetCycles })
			});
			const data = await res.json();
			if (!res.ok || data.error) {
				throw new Error(apiErrorMessage(data, `Preview failed (${res.status})`));
			}
			preview = data.preview as AutoBalancePreview;
		} catch (error) {
			previewError = error instanceof Error ? error.message : 'Failed to load preview.';
		} finally {
			previewPending = false;
		}
	}

	async function executeBalance(): Promise<void> {
		if (!canConfirm) return;
		executePending = true;
		executeError = null;
		executeSuccess = null;
		const t = toast.loading('Preparing funding...');
		try {
			const res = await fetch('/api/bot/balance', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'execute', targetCycles })
			});
			const data = await res.json();
			if (!res.ok || data.error) {
				throw new Error(apiErrorMessage(data, `Execute failed (${res.status})`));
			}
			if (data.snapshot) {
				onExecuted(data.snapshot as RuntimeSnapshot);
			}
			executeSuccess = 'Funding prep completed. Wallet balances updated.';
			preview = null;
			t?.success('Funding prep completed', { durationMs: 3000 });
		} catch (error) {
			executeError = error instanceof Error ? error.message : 'Funding prep execution failed.';
			t?.error('Funding prep failed', { durationMs: 4000 });
		} finally {
			executePending = false;
		}
	}

	function handleClose(): void {
		if (executePending) return;
		preview = null;
		previewError = null;
		executeError = null;
		executeSuccess = null;
		targetCycles = defaultCycles;
		onClose();
	}

	const stateLabel = (state: string) => {
		if (state === 'ready') return 'Funded';
		if (state === 'planned') return 'Swap planned';
		if (state === 'insufficient-source-asset') return 'Low source asset';
		if (state === 'blocked') return 'Blocked';
		return state;
	};

	const stateBadge = (state: string) => {
		if (state === 'ready') return 'badge-success';
		if (state === 'planned') return 'badge-warning';
		if (state === 'insufficient-source-asset') return 'badge-error';
		return 'badge-ghost';
	};

	$effect(() => {
		if (open) {
			targetCycles = defaultCycles;
			preview = null;
			previewError = null;
			executeError = null;
			executeSuccess = null;
			previewPending = false;
		}
	});
</script>

<AppModal {open} onClose={handleClose} title="Prepare Funding" maxWidth="max-w-xl">
	<div class="bg-base-100">
		<div class="border-b border-base-300 px-6 py-5">
			<p class="text-xs tracking-[0.14em] text-base-content/70 uppercase">Wallet Preparation</p>
			<h3 class="text-2xl font-semibold">Prepare Funding</h3>
			<button
				class="btn absolute top-4 right-4 btn-circle btn-ghost btn-sm"
				onclick={handleClose}
				type="button">✕</button
			>
		</div>

		<div class="space-y-5 px-6 py-6 text-sm text-base-content/85">
			<div class="flex items-end gap-3">
				<label class="floating-label w-28">
					<span>Target cycles</span>
					<input
						type="number"
						class="input input-sm w-full"
						min="1"
						max="20"
						placeholder="Target cycles"
						bind:value={targetCycles}
						disabled={previewPending || executePending}
					/>
				</label>
				<button
					class="btn btn-outline btn-sm btn-info"
					onclick={loadPreview}
					disabled={previewPending || executePending}
				>
					{previewPending ? 'Loading...' : 'Refresh'}
				</button>
			</div>

			{#if previewPending && !preview}
				<div class="flex flex-col items-center gap-3 py-6">
					<span class="loading loading-lg loading-spinner text-info"></span>
					<p class="text-sm text-base-content/60">Computing funding preview...</p>
				</div>
			{:else if !preview && !previewError}
				<div class="rounded-box border border-dashed border-base-300 bg-base-200/70 p-4 text-sm text-base-content/65">
					Enter the target cycles you want, then press <span class="font-semibold text-base-content">Refresh</span> to compute the funding preview.
				</div>
			{:else if previewError}
				<div class="rounded-box bg-error/10 p-4 text-sm text-error">{previewError}</div>
			{:else if preview}
				<div class="rounded-box bg-base-200 p-3 text-xs">
					<span class="font-semibold">
						Reference price {currency(preview.referencePrice, 4)} · {preview.targetCycles} cycle(s)
					</span>
				</div>
				{#if preview.shareTransfer}
					<div class="alert border border-info/60 bg-info/20 text-base-content shadow-[0_0_0_1px_rgba(56,189,248,0.24)]">
						<span aria-hidden="true" class="text-lg leading-none">↔</span>
						<div class="space-y-1">
							<p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-info">
								Balance Share Planned
							</p>
							<p class="text-sm font-semibold text-base-content">
								{preview.shareTransfer.from === 'accountA' ? preview.accountA.label : preview.accountB.label}
								→
								{preview.shareTransfer.to === 'accountA' ? preview.accountA.label : preview.accountB.label}
								·
								{formatAssetAmount(preview.shareTransfer.amount, preview.shareTransfer.asset)}
							</p>
						</div>
					</div>
				{/if}

				<div class="grid gap-4 lg:grid-cols-2">
					{#each [preview.accountA, preview.accountB] as acct}
						<div class="card border border-base-300 bg-base-200 shadow-sm">
							<div class="card-body gap-3 p-4">
								<div class="flex items-start justify-between gap-3">
									<p class="text-sm font-semibold">{acct.label}</p>
									<span class={`badge badge-sm whitespace-nowrap ${stateBadge(acct.state)}`}>
										{stateLabel(acct.state)}
									</span>
								</div>
								<div class="mt-2 space-y-2 text-sm">
									<div class="flex justify-between text-base-content/70">
										<span>1-cycle capital</span><strong
											>{formatAssetAmount(acct.workingCapitalAmount, acct.targetAsset)}</strong
										>
									</div>
									<div class="flex justify-between text-base-content/70">
										<span>Reserve buffer</span><strong
											>{formatAssetAmount(acct.reserveAmount, acct.targetAsset)}</strong
										>
									</div>
									<div class="flex justify-between">
										<span>Target {acct.targetAsset}</span><strong
											>{formatAssetAmount(acct.targetAmount, acct.targetAsset)}</strong
										>
									</div>
									<div class="flex justify-between">
										<span>Current {acct.targetAsset}</span><strong
											>{formatAssetAmount(acct.currentAmount, acct.targetAsset)}</strong
										>
									</div>
									<div class="flex justify-between">
										<span>Shortfall</span>
										<strong class={acct.shortfallAmount > 0 ? 'text-warning' : 'text-success'}>
											{formatAssetAmount(acct.shortfallAmount, acct.targetAsset)}
										</strong>
									</div>
									{#if acct.state === 'planned' || acct.state === 'insufficient-source-asset'}
										<div class="flex justify-between">
											<span>Est. {acct.sourceAsset} swap</span><strong
												>{formatAssetAmount(acct.estimatedSourceAmount, acct.sourceAsset)}</strong
											>
										</div>
										<div class="flex justify-between">
											<span>Available {acct.sourceAsset}</span><strong
												>{formatAssetAmount(acct.availableSourceAmount, acct.sourceAsset)}</strong
											>
										</div>
									{/if}
								</div>
								{#if acct.reason}
									<p class="mt-2 text-xs text-warning">{acct.reason}</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>

				<p class="text-xs text-base-content/60">{preview.message}</p>
			{/if}

			{#if executeError}
				<div class="rounded-box bg-error/10 p-4 text-sm text-error">{executeError}</div>
			{/if}
			{#if executeSuccess}
				<div class="rounded-box bg-success/10 p-4 text-sm text-success">{executeSuccess}</div>
			{/if}
		</div>

		<div class="flex items-center justify-end gap-3 border-t border-base-300/60 px-6 py-5">
			<button
				class="btn btn-ghost btn-sm"
				onclick={handleClose}
				type="button"
				disabled={executePending}>Cancel</button
			>
			<button
				class="btn btn-sm btn-primary"
				onclick={executeBalance}
				disabled={!canConfirm || !anyPlanned}
			>
				{#if executePending}
					Swapping...
				{:else if preview && !anyPlanned && preview.canExecute}
					No prep needed
				{:else}
					Confirm Prep
				{/if}
			</button>
		</div>
	</div>
</AppModal>
