<script lang="ts">
	import { formatAssetAmount, currency } from '../_helpers/page-view.js';
	import type { RuntimeSnapshot } from '$lib/types/bot.js';
	import AppModal from './AppModal.svelte';

	type PreflightAccount = RuntimeSnapshot['preflight']['accountA'];

	type Props = {
		open: boolean;
		onClose: () => void;
		promptMode: 'start' | 'clean' | 'swap' | null;
		preflightPending: boolean;
		modalPreflight: RuntimeSnapshot['preflight'];
		preflightError: string | null;
		preflightAccounts: Array<{
			key: 'accountA' | 'accountB';
			status: PreflightAccount;
			address: string | undefined;
		}>;
		snapshot: RuntimeSnapshot;
		controlPending: boolean;
		startBlocked: boolean;
		onConfirm: () => Promise<void>;
	};

	let {
		open,
		onClose,
		promptMode,
		preflightPending,
		modalPreflight,
		preflightError,
		preflightAccounts,
		snapshot,
		controlPending,
		startBlocked,
		onConfirm
	}: Props = $props();

	const preflightHeadline = $derived.by(() => {
		if (preflightPending) {
			return 'Inspecting margin managers, open orders, and wallet balances before start.';
		}
		if (preflightError) {
			return preflightError;
		}
		if (modalPreflight.state === 'config-required') {
			return 'Add config to calculate start readiness.';
		}
		if (modalPreflight.state === 'waiting-price') {
			return 'Waiting for live SUI price to calculate wallet needs.';
		}
		if (modalPreflight.state === 'needs-reset') {
			return 'One or both accounts still have open orders, debt, or residual margin balances from a previous run.';
		}
		if (modalPreflight.ready) {
			return 'Safe to press Start. Wallets are funded and both margin accounts are flat.';
		}
		return 'One or both wallets still need funding before the next cycle.';
	});

	const accountStatusText = (state: PreflightAccount['state']) => {
		if (state === 'ready') return 'Wallet ready';
		if (state === 'reset-required') return 'Cleanup required';
		if (state === 'needs-swap') return 'Auto-swap';
		if (state === 'deposit-required') return 'Deposit needed';
		return 'Waiting';
	};

	const accountStatusClass = (state: PreflightAccount['state']) => {
		if (state === 'ready') return 'badge-success';
		if (state === 'reset-required') return 'badge-error';
		if (state === 'needs-swap') return 'badge-warning';
		if (state === 'waiting-price') return 'badge-neutral';
		return 'badge-success';
	};
</script>

<AppModal
	{open}
	{onClose}
	title={promptMode === 'clean'
		? 'Clear bot database records?'
		: promptMode === 'swap'
			? 'Swap Long / Short Wallets'
			: 'Review balances before start'}
	maxWidth="max-w-xl"
>
	<div class="bg-base-100">
		<div class="border-b border-base-300 px-6 py-5">
			<div class="mb-4">
				<p class="text-xs tracking-[0.14em] text-base-content/70 uppercase">
					{promptMode === 'clean'
						? 'Clean Session Data'
						: promptMode === 'swap'
							? 'Swap Wallets'
							: 'Preflight Check'}
				</p>
				<h3 class="text-2xl font-semibold">
					{promptMode === 'clean'
						? 'Clear bot database records?'
						: promptMode === 'swap'
							? 'Swap Long / Short Wallets'
							: 'Review balances before start'}
				</h3>
			</div>
			<button
				class="btn absolute top-4 right-4 btn-circle btn-ghost btn-sm"
				onclick={onClose}
				type="button">✕</button
			>
		</div>

		<div class="space-y-5 px-6 py-6 text-sm text-base-content/85">
			{#if promptMode === 'start'}
				{#if preflightPending}
					<div class="card border border-base-300 bg-base-200 shadow-sm">
						<div class="card-body p-6">
							<div class="flex flex-col items-center justify-center gap-3">
								<span class="loading loading-lg loading-spinner text-info"></span>
								<div class="space-y-2 text-center">
									<p class="text-base font-medium">Inspecting managers...</p>
									<p class="text-sm text-base-content/60">{preflightHeadline}</p>
								</div>
							</div>
						</div>
					</div>
				{:else}
					<div class="flex flex-wrap items-start justify-between gap-4">
						<p>{preflightHeadline}</p>
						<span
							class={`badge whitespace-nowrap ${modalPreflight.ready ? 'badge-success' : modalPreflight.state === 'needs-reset' ? 'badge-error' : modalPreflight.state === 'waiting-price' ? 'badge-warning' : 'badge-ghost'}`}
						>
							{modalPreflight.ready
								? 'Ready'
								: modalPreflight.state === 'needs-reset'
									? 'Blocked'
									: modalPreflight.state === 'waiting-price'
										? 'Pending'
										: 'Needs review'}
						</span>
					</div>

					<div class="grid gap-4 lg:grid-cols-2">
						{#each preflightAccounts as item}
							<div class="card border border-base-300 bg-base-200 shadow-sm">
								<div class="card-body gap-3 p-4">
									<div class="flex items-start justify-between gap-4">
										<div>
											<p class="text-sm font-semibold">{item.status.label}</p>
											<p class="mt-1 text-xs text-base-content/65">
												{item.address
													? item.address.slice(0, 8) + '...' + item.address.slice(-4)
													: 'n/a'}
											</p>
										</div>
										<span
											class={`badge justify-center badge-sm whitespace-nowrap ${accountStatusClass(item.status.state)}`}
										>
											{accountStatusText(item.status.state)}
										</span>
									</div>

									<div class="mt-4 space-y-2 text-sm">
										<div class="flex items-center justify-between gap-4">
											<span>Required in wallet</span>
											<strong
												>{formatAssetAmount(
													item.status.requiredAmount,
													item.status.requiredAsset
												)}</strong
											>
										</div>
										<div class="flex items-center justify-between gap-4">
											<span>Available now</span>
											<strong
												>{formatAssetAmount(
													item.status.availableAmount,
													item.status.requiredAsset
												)}</strong
											>
										</div>
										<div class="flex items-center justify-between gap-4">
											<span>Missing</span>
											<strong class={item.status.missingAmount > 0 ? 'text-error' : 'text-success'}>
												{formatAssetAmount(item.status.missingAmount, item.status.requiredAsset)}
											</strong>
										</div>
										<div class="flex items-center justify-between gap-4">
											<span>Open orders</span>
											<strong
												class={item.status.openOrdersCount > 0
													? 'text-error'
													: 'text-base-content/85'}
											>
												{item.status.openOrdersCount}
											</strong>
										</div>
									</div>

									{#if item.status.state === 'reset-required'}
										<div class="mt-4 rounded-box bg-base-100 p-3 text-xs">
											<p class="text-warning">
												{item.status.blockingReason ??
													'This account still has leftover margin state from a previous run.'}
											</p>
											<div class="mt-3 grid gap-2 sm:grid-cols-2">
												<div class="flex items-center justify-between">
													<span>Margin SUI asset</span><strong
														>{formatAssetAmount(item.status.baseAsset, 'SUI')}</strong
													>
												</div>
												<div class="flex items-center justify-between">
													<span>Margin USDC asset</span><strong
														>{formatAssetAmount(item.status.quoteAsset, 'USDC')}</strong
													>
												</div>
												<div class="flex items-center justify-between">
													<span>SUI debt</span><strong
														>{formatAssetAmount(item.status.baseDebt, 'SUI')}</strong
													>
												</div>
												<div class="flex items-center justify-between">
													<span>USDC debt</span><strong
														>{formatAssetAmount(item.status.quoteDebt, 'USDC')}</strong
													>
												</div>
											</div>
										</div>
									{:else if item.status.state === 'needs-swap'}
										<div class="mt-4 rounded-box bg-base-100 p-3 text-xs">
											<p>
												Bot can auto-swap about
												<strong class="ml-1"
													>{formatAssetAmount(
														item.status.autoSwapAmountNeeded ?? 0,
														item.status.autoSwapAsset
													)}</strong
												>
												from wallet.
											</p>
										</div>
									{:else if item.status.state === 'deposit-required'}
										<div class="mt-4 rounded-box bg-base-100 p-3 text-xs text-warning">
											<p>
												Top up more {item.status.requiredAsset} before start. Auto-swap
												{item.status.autoSwapEnabled
													? ' is not sufficient for the shortfall.'
													: ' is disabled in config.'}
											</p>
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>

					<div class="rounded-box bg-base-200 p-3 text-xs">
						<span class="font-semibold">
							Max cycle {currency(
								modalPreflight.plannedNotionalUsd || snapshot.config?.notionalSizeUsd || 0
							)} · Estimated size {formatAssetAmount(modalPreflight.estimatedQuantitySui, 'SUI')} · Price
							ref {currency(modalPreflight.referencePrice, 4)}
						</span>
						{#if modalPreflight.autoReduced}
							<br />
							<span class="text-info">
								Effective size this cycle: {currency(modalPreflight.effectiveNotionalUsd)} · Auto-reduced
								from {currency(modalPreflight.configuredNotionalUsd)}
							</span>
						{/if}
						{#if modalPreflight.state === 'needs-reset'}
							<br />
							<span class="text-warning">Flatten leftover manager state before starting</span>
						{/if}
					</div>
				{/if}
			{:else if promptMode === 'swap'}
				<p>
					Switching accounts will make your current Long (SUI) wallet act as the Short (USDC)
					wallet, and vice versa. Please ensure you do not have any open physical positions on SUI
					before proceeding.
				</p>
				<div class="mt-4 alert alert-warning">
					<div>
						<h3 class="text-sm font-semibold">Caution</h3>
						<p class="mt-1 text-xs opacity-90">
							Swapping while the bot is running will require a restart.
						</p>
					</div>
				</div>
			{:else if promptMode === 'clean'}
				<p>
					This will stop the bot and try to flatten positions while preserving cycle history,
					runtime logs, and stored settings/state.
				</p>

				<div class="rounded-box bg-base-200 p-3 text-xs">
					<p class="mb-2 text-info">Data preserved</p>
					<ul class="space-y-2 text-sm">
						<li><code>bot_logs</code>: runtime feed stays available for later analysis</li>
						<li>
							<code>bot_cycles</code>: cycle history, order snapshots, PNL, fees, timestamps remain
							intact
						</li>
						<li>
							<code>bot_runtime_state</code>: saved manager ids and runtime state are retained
						</li>
					</ul>
				</div>

				<p class="text-xs text-base-content/65">
					Wallet balances on-chain are never deleted. Clean only tries to flatten on-chain exposure
					and reset the live run.
				</p>
			{/if}
		</div>

		<div class="flex items-center justify-end gap-3 border-t border-base-300/60 px-6 py-5">
			<button class="btn btn-ghost btn-sm" onclick={onClose} type="button">Cancel</button>
			<button
				class={`btn btn-sm ${promptMode === 'clean' ? 'btn-error' : promptMode === 'swap' ? 'btn-warning' : 'btn-success'}`}
				onclick={onConfirm}
				disabled={controlPending || (promptMode === 'start' && (preflightPending || startBlocked))}
			>
				{#if preflightPending && promptMode === 'start'}
					Checking...
				{:else if controlPending}
					{promptMode === 'clean'
						? 'Cleaning...'
						: promptMode === 'swap'
							? 'Swapping...'
							: 'Starting...'}
				{:else}
					{promptMode === 'clean'
						? 'Confirm Clean'
						: promptMode === 'swap'
							? 'Confirm Swap'
							: 'Confirm Start'}
				{/if}
			</button>
		</div>
	</div>
</AppModal>
