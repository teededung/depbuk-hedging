<script lang="ts">
	import type { RuntimeSnapshot } from '$lib/types/bot.js';
	import { buildAccountLogData } from '../_helpers/page-view.js';
	import RuntimeLogColumn from './RuntimeLogColumn.svelte';

	type Props = {
		snapshot: RuntimeSnapshot;
		openAccountACycleKey: string | null;
		openAccountBCycleKey: string | null;
		onCycleToggle: (
			scope: 'accountA' | 'accountB',
			key: string,
			target: EventTarget | null
		) => void;
	};

	let { snapshot, openAccountACycleKey, openAccountBCycleKey, onCycleToggle }: Props = $props();

	const accountLabels = $derived.by(() => ({
		accountALabel: snapshot.config?.accountALabel ?? snapshot.preflight.accountA.label,
		accountBLabel: snapshot.config?.accountBLabel ?? snapshot.preflight.accountB.label
	}));
	const accountALogData = $derived.by(() =>
		buildAccountLogData(snapshot.logs, 'accountA', accountLabels)
	);
	const accountBLogData = $derived.by(() =>
		buildAccountLogData(snapshot.logs, 'accountB', accountLabels)
	);
</script>

<section class="card rounded-2xl border border-base-300 bg-base-200 shadow-sm">
	<div class="card-body gap-6 p-6">
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div>
				<p class="text-xs tracking-[0.14em] text-base-content/70 uppercase">Live Logs</p>
				<h3 class="card-title">Runtime feed by account</h3>
			</div>
		</div>

		<div class="grid gap-6 xl:grid-cols-2">
			<RuntimeLogColumn
				title={snapshot.config?.accountALabel ?? 'Account A (Long)'}
				accountAddress={snapshot.balances.accountA.address ?? 'n/a'}
				logData={accountALogData}
				openCycleKey={openAccountACycleKey}
				{onCycleToggle}
				scope="accountA"
				network={snapshot.config?.network ?? 'mainnet'}
			/>

			<RuntimeLogColumn
				title={snapshot.config?.accountBLabel ?? 'Account B (Short)'}
				accountAddress={snapshot.balances.accountB.address ?? 'n/a'}
				logData={accountBLogData}
				openCycleKey={openAccountBCycleKey}
				{onCycleToggle}
				scope="accountB"
				network={snapshot.config?.network ?? 'mainnet'}
			/>
		</div>
	</div>
</section>
