<script lang="ts">
	import { currency, formatNumber } from '../_helpers/page-view.js';
	import type { BotAccountKey, RuntimeSnapshot } from '$lib/types/bot.js';
	import AppModal from './AppModal.svelte';

	type Props = {
		open: boolean;
		onClose: () => void;
		depositQr: string;
		depositTarget: BotAccountKey;
		snapshot: RuntimeSnapshot;
		copySucceeded: boolean;
		depositLabel: string;
		onSwitchTarget: (account: BotAccountKey) => Promise<void> | void;
		onCopyAddress: () => Promise<void> | void;
	};

	let {
		open,
		onClose,
		depositQr,
		depositTarget,
		snapshot,
		copySucceeded,
		depositLabel,
		onSwitchTarget,
		onCopyAddress
	}: Props = $props();

	const depositTargetAddress = $derived.by(() =>
		depositTarget === 'accountA' ? snapshot.balances.accountA.address : snapshot.balances.accountB.address
	);
	const depositTargetAccount = $derived.by(() =>
		depositTarget === 'accountA' ? snapshot.balances.accountA : snapshot.balances.accountB
	);
</script>

<AppModal {open} onClose={onClose} title={depositLabel} maxWidth="max-w-xl">
	<div class="bg-base-100 p-6">
		<div class="border-b border-base-300 pb-4">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-xs uppercase tracking-[0.14em] text-base-content/70">Quick Deposit</p>
					<h3 class="text-xl font-semibold">{depositLabel}</h3>
				</div>
				<button class="btn btn-circle btn-sm btn-ghost" onclick={onClose} type="button">✕</button>
			</div>

			<div class="join mt-4 w-full">
				<button
					class="btn btn-sm join-item"
					class:btn-active={depositTarget === 'accountA'}
					onclick={() => onSwitchTarget('accountA')}
					type="button"
				>
					Account A
				</button>
				<button
					class="btn btn-sm join-item"
					class:btn-active={depositTarget === 'accountB'}
					onclick={() => onSwitchTarget('accountB')}
					type="button"
				>
					Account B
				</button>
			</div>
		</div>

		<div class="mt-5 grid gap-5 xl:grid-cols-[260px_1fr]">
			<div class="card bg-base-200 border border-base-300 shadow-sm">
				<div class="card-body p-4">
					{#if depositQr}
						<img src={depositQr} alt={`Deposit QR for ${depositLabel}`} class="h-52 w-52 mx-auto" />
					{:else}
						<div class="grid h-52 place-items-center text-sm text-base-content/60">Address unavailable</div>
					{/if}
				</div>
			</div>

			<div class="grid gap-4">
				<div class="card bg-base-200 border border-base-300 shadow-sm">
					<div class="card-body gap-3 p-4">
						<div class="mb-2 flex items-center justify-between gap-3 text-sm">
							<p class="text-xs uppercase tracking-[0.14em] text-base-content/70">Address</p>
							<button
								class={`btn btn-square btn-xs ${copySucceeded ? 'btn-success' : 'btn-outline'}`}
								onclick={onCopyAddress}
								type="button"
								disabled={!depositTargetAddress}
								aria-label={`Copy ${depositLabel} address`}
								title="Copy address"
							>
								{copySucceeded ? '✓' : '⎘'}
							</button>
						</div>
						<p class="break-all text-sm">{depositTargetAddress ?? 'n/a'}</p>
					</div>
				</div>

				<div class="card bg-base-200 border border-base-300 shadow-sm text-sm">
					<div class="card-body gap-2 p-4">
						<p>SUI: {formatNumber(depositTargetAccount.sui, 4)}</p>
						<p>USDC: {formatNumber(depositTargetAccount.usdc, 2)}</p>
						<p>Total: {currency(depositTargetAccount.totalUsdc, 2)}</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</AppModal>
