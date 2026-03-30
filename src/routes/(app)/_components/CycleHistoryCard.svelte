<script lang="ts">
	import type { RuntimeSnapshot } from '$lib/types/bot.js';
	import {
		currency,
		formatAssetAmount,
		formatClock,
		formatDateTime,
		orderDisplayPrice,
		orderDisplayQuantity,
		orderSummaryLabel,
		ordersForPhase
	} from '../_helpers/page-view.js';

	type Props = {
		snapshot: RuntimeSnapshot;
		accountALabel: string;
		accountBLabel: string;
	};

	let { snapshot, accountALabel, accountBLabel }: Props = $props();

	const recentCycles = $derived.by(() => snapshot.history.slice(0, 2));

const orderStatusClass = (status: RuntimeSnapshot['history'][number]['orders'][number]['status']): string => {
		if (status === 'filled') return 'badge-success';
		if (status === 'failed') return 'badge-error';
		if (status === 'cancelled') return 'badge-warning';
		return 'badge-ghost';
	};
</script>

<article class="card rounded-2xl border border-base-300 bg-base-200 shadow-sm">
	<div class="card-body gap-6 p-6">
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div>
				<p class="text-xs uppercase tracking-[0.14em] text-base-content/70">Cycle History</p>
				<h3 class="card-title">Recent cycles</h3>
			</div>
			<p class="text-sm text-base-content/70">
				Pool: {snapshot.config?.poolKey ?? 'n/a'} · Notional: {currency(snapshot.config?.notionalSizeUsd ?? 0)}
			</p>
		</div>

		{#if recentCycles.length === 0}
			<div class="rounded-lg border border-dashed border-base-300 p-6 text-center text-sm text-base-content/70">No cycle data yet.</div>
		{:else}
			<div class="space-y-4">
				{#each recentCycles as cycle}
					<div class="rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm">
						<div class="grid gap-4 lg:grid-cols-3">
							<div>
								<div class="font-semibold">#{cycle.cycleNumber}</div>
								<p class="text-xs text-base-content/70">{cycle.status.toUpperCase()} · {formatDateTime(cycle.startedAt)}</p>
							</div>
							<div>
								<div class="font-semibold">{currency(cycle.volumeUsd)}</div>
								<p class="text-xs text-base-content/70">PNL {currency(cycle.pnlUsd, 4)} · Fees {currency(cycle.feesUsd, 4)}</p>
							</div>
							<div>
								<div class="font-semibold">{currency(cycle.openPrice, 4)} → {currency(cycle.closePrice, 4)}</div>
								<p class="text-xs text-base-content/70">Hold {formatClock(cycle.holdSecondsActual || cycle.holdSecondsTarget)}</p>
							</div>
						</div>

						<div class="mt-4 grid gap-5 border-t border-base-300 pt-4 lg:grid-cols-2">
							<div class="space-y-2">
								<p class="text-[11px] uppercase tracking-[0.22em] text-base-content/60">Open fills</p>
								{#each ordersForPhase(cycle.orders, 'OPEN') as order}
									<div class="flex items-start justify-between gap-3 rounded-xl border border-base-300 bg-base-200 p-3">
										<div>
											<p class="text-sm">{orderSummaryLabel(order, accountALabel, accountBLabel)}</p>
											<p class="text-xs text-base-content/70">
												{formatAssetAmount(orderDisplayQuantity(order), 'SUI')} @ {currency(orderDisplayPrice(order), 4)}
											</p>
										</div>
										<span class={`badge badge-sm ${orderStatusClass(order.status)}`}>{order.status}</span>
									</div>
								{/each}
							</div>
							<div class="space-y-2">
								<p class="text-[11px] uppercase tracking-[0.22em] text-base-content/60">Close fills</p>
								{#each ordersForPhase(cycle.orders, 'CLOSE') as order}
									<div class="flex items-start justify-between gap-3 rounded-xl border border-base-300 bg-base-200 p-3">
										<div>
											<p class="text-sm">{orderSummaryLabel(order, accountALabel, accountBLabel)}</p>
											<p class="text-xs text-base-content/70">
												{formatAssetAmount(orderDisplayQuantity(order), 'SUI')} @ {currency(orderDisplayPrice(order), 4)}
											</p>
										</div>
										<span class={`badge badge-sm ${orderStatusClass(order.status)}`}>{order.status}</span>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</article>
