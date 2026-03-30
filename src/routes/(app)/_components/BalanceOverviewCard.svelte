<script lang="ts">
	import type { RuntimeSnapshot } from '$lib/types/bot.js';
	import { currency, formatNumber, shortAddress } from '../_helpers/page-view.js';

	type Props = {
		snapshot: RuntimeSnapshot;
		accountALabel: string;
		accountBLabel: string;
		onOpenDeposit: (account: 'accountA' | 'accountB') => Promise<void> | void;
		onOpenAutoBalance: () => void;
		onOpenSwapConfirmation: () => void;
	};

	let { snapshot, accountALabel, accountBLabel, onOpenDeposit, onOpenAutoBalance, onOpenSwapConfirmation }: Props =
		$props();
</script>

<article class="card rounded-2xl border border-base-300 bg-base-200 shadow-sm">
	<div class="card-body gap-6 p-6">
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div>
				<p class="text-xs tracking-[0.14em] text-base-content/70 uppercase">Account Balances</p>
				<h3 class="card-title">Wallet overview</h3>
			</div>
			<div class="flex items-center gap-3">
				<button class="btn btn-outline btn-sm btn-ghost tooltip tooltip-bottom" data-tip="Swap Long/Short Accounts" onclick={onOpenSwapConfirmation} aria-label="Swap Accounts">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-left-right"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>
				</button>
				<button class="btn btn-outline btn-sm btn-accent" onclick={onOpenAutoBalance}>
					Auto-Balance
				</button>
				<p class="text-sm text-base-content/70">
					Total value: {currency(snapshot.balances.totalUsdc)}
				</p>
			</div>
		</div>

		<div class="grid gap-5 md:grid-cols-2">
			<div class="card rounded-2xl border border-base-300 bg-base-100 shadow-sm">
				<div class="card-body gap-5 p-6">
					<div class="flex items-start justify-between gap-3">
						<div>
							<h4 class="mb-1 card-title">{accountALabel}</h4>
							<p class="text-xs text-base-content/70">
								{shortAddress(snapshot.balances.accountA.address)}
							</p>
						</div>
						<span class="font-semibold text-primary"
							>{currency(snapshot.balances.accountA.totalUsdc, 2)}</span
						>
					</div>
					<div class="grid gap-3">
						<div class="flex items-center justify-between text-sm">
							<span>SUI</span>
							<strong>{formatNumber(snapshot.balances.accountA.sui, 4)}</strong>
						</div>
						<div class="flex items-center justify-between text-sm">
							<span>USDC</span>
							<strong>{formatNumber(snapshot.balances.accountA.usdc, 2)}</strong>
						</div>
					</div>
					<div class="card-actions justify-end pt-3">
						<button
							class="btn w-full btn-outline btn-sm btn-primary"
							onclick={() => onOpenDeposit('accountA')}
							disabled={!snapshot.balances.accountA.address}
						>
							Quick Deposit
						</button>
					</div>
				</div>
			</div>

			<div class="card rounded-2xl border border-base-300 bg-base-100 shadow-sm">
				<div class="card-body gap-5 p-6">
					<div class="flex items-start justify-between gap-3">
						<div>
							<h4 class="mb-1 card-title">{accountBLabel}</h4>
							<p class="text-xs text-base-content/70">
								{shortAddress(snapshot.balances.accountB.address)}
							</p>
						</div>
						<span class="font-semibold text-primary"
							>{currency(snapshot.balances.accountB.totalUsdc, 2)}</span
						>
					</div>
					<div class="grid gap-3">
						<div class="flex items-center justify-between text-sm">
							<span>SUI</span>
							<strong>{formatNumber(snapshot.balances.accountB.sui, 4)}</strong>
						</div>
						<div class="flex items-center justify-between text-sm">
							<span>USDC</span>
							<strong>{formatNumber(snapshot.balances.accountB.usdc, 2)}</strong>
						</div>
					</div>
					<div class="card-actions justify-end pt-3">
						<button
							class="btn w-full btn-outline btn-sm btn-primary"
							onclick={() => onOpenDeposit('accountB')}
							disabled={!snapshot.balances.accountB.address}
						>
							Quick Deposit
						</button>
					</div>
				</div>
			</div>
		</div>

		<div
			class="mt-auto flex flex-wrap justify-between gap-2 border-t border-base-300 pt-3 text-sm text-base-content/70"
		>
			<span>Source: {snapshot.balances.source}</span>
			<span>{snapshot.balances.updatedAt}</span>
		</div>
	</div>
</article>
