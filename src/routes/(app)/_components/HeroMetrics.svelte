<script lang="ts">
	import { cubicOut } from 'svelte/easing';
	import { Tween } from 'svelte/motion';
	import { currency } from '../_helpers/page-view.js';
	import type { RuntimeSnapshot } from '$lib/types/bot.js';

	type Props = {
		snapshot: RuntimeSnapshot;
		accountALabel: string;
		accountBLabel: string;
		activeCycleLabel?: string;
		activeCycleProgress?: number;
		startPending?: boolean;
		streamError?: boolean;
		priceRingCircumference: number;
		priceRingOffset: number;
	};

	let {
		snapshot,
		accountALabel,
		accountBLabel,
		activeCycleLabel = 'Awaiting next cycle',
		activeCycleProgress = 0,
		startPending = false,
		streamError = false,
		priceRingCircumference,
		priceRingOffset
	}: Props = $props();

	const animatedPrice = new Tween(0, {
		duration: 420,
		easing: cubicOut
	});
	let previousPrice = $state(0);
	let priceDirection = $state<'up' | 'down' | 'flat'>('flat');
	let priceFlashTimer: ReturnType<typeof setTimeout> | null = null;
	let priceTrail = $state<number[]>([]);
	let lastPriceUpdatedAt = $state('');
	let pnlVisible = $state(false);
	const maxPriceTrailPoints = 160;

	const buildSparklinePath = (
		values: number[],
		width: number,
		height: number,
		padding: number
	): string => {
		if (values.length < 2) return '';
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = Math.max(max - min, 0.0001);
		const innerWidth = width - padding * 2;
		const innerHeight = height - padding * 2;
		const points = values.map((value, index) => {
			const ratioX = values.length === 1 ? 0 : index / (values.length - 1);
			const ratioY = (value - min) / span;
			const x = padding + ratioX * innerWidth;
			const y = padding + (1 - ratioY) * innerHeight;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		});
		return `M ${points.join(' L ')}`;
	};

	const buildSparklineAreaPath = (
		values: number[],
		width: number,
		height: number,
		padding: number
	): string => {
		if (values.length < 2) return '';
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = Math.max(max - min, 0.0001);
		const innerWidth = width - padding * 2;
		const innerHeight = height - padding * 2;
		const bottomY = height - padding;
		const points = values.map((value, index) => {
			const ratioX = values.length === 1 ? 0 : index / (values.length - 1);
			const ratioY = (value - min) / span;
			const x = padding + ratioX * innerWidth;
			const y = padding + (1 - ratioY) * innerHeight;
			return { x, y };
		});
		const topLine = points
			.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
			.join(' L ');
		const end = points[points.length - 1];
		const start = points[0];
		return `M ${topLine} L ${end.x.toFixed(2)},${bottomY.toFixed(2)} L ${start.x.toFixed(
			2
		)},${bottomY.toFixed(2)} Z`;
	};

	$effect(() => {
		const nextPrice = snapshot.price.price;
		const nextPriceUpdatedAt = snapshot.price.updatedAt;
		animatedPrice.target = nextPrice;
		if (nextPrice === previousPrice) return;

		const hadPreviousPrice = previousPrice > 0;
		const nextDirection = nextPrice > previousPrice ? 'up' : 'down';
		previousPrice = nextPrice;

		if (!hadPreviousPrice) {
			priceDirection = 'flat';
			return;
		}

		priceDirection = nextDirection;
		if (priceFlashTimer) clearTimeout(priceFlashTimer);
		priceFlashTimer = setTimeout(() => {
			priceDirection = 'flat';
			priceFlashTimer = null;
		}, 900);
	});

	$effect(() => {
		const nextPrice = snapshot.price.price;
		const nextPriceUpdatedAt = snapshot.price.updatedAt;
		if (!Number.isFinite(nextPrice) || nextPrice <= 0) return;
		if (!nextPriceUpdatedAt || nextPriceUpdatedAt === lastPriceUpdatedAt) return;
		lastPriceUpdatedAt = nextPriceUpdatedAt;
		priceTrail = [...priceTrail.slice(-(maxPriceTrailPoints - 1)), nextPrice];
	});

	$effect(() => {
		return () => {
			if (priceFlashTimer) {
				clearTimeout(priceFlashTimer);
				priceFlashTimer = null;
			}
		};
	});

	const priceValueClass = $derived.by(() => {
		if (priceDirection === 'up') {
			return 'scale-[1.02] drop-shadow-[0_0_16px_rgba(34,197,94,0.26)]';
		}
		if (priceDirection === 'down') {
			return 'scale-[1.02] drop-shadow-[0_0_16px_rgba(248,113,113,0.26)]';
		}
		return 'scale-100 drop-shadow-none';
	});

	const priceValueStyle = $derived.by(() => {
		if (priceDirection === 'up') {
			return 'color: var(--color-success);';
		}
		if (priceDirection === 'down') {
			return 'color: var(--color-error);';
		}
		return 'color: var(--color-base-content);';
	});

	const sessionPnlText = $derived.by(() => currency(snapshot.stats.sessionPnl, 4));
	const sessionPnlClass = $derived.by(() =>
		snapshot.stats.sessionPnl > 0
			? 'text-success'
			: snapshot.stats.sessionPnl < 0
				? 'text-error'
				: 'text-base-content'
	);
	const sessionPnlValueClass = $derived.by(() =>
		pnlVisible ? sessionPnlClass : 'text-base-content/80'
	);
	const sessionPnlRevealLabel = $derived.by(() =>
		pnlVisible ? 'Hide total PnL' : 'Reveal total PnL'
	);
	const uiRuntimeMessage = $derived.by(() => snapshot.message.replace(/deepbook/gi, 'runtime'));
	const sessionCostsText = $derived.by(
		() =>
			`Fees: ${currency(snapshot.stats.sessionFees, 4)} · Gas: ${currency(snapshot.stats.sessionGas, 4)}`
	);
	const sparklinePath = $derived.by(() => buildSparklinePath(priceTrail, 460, 96, 1));
	const sparklineAreaPath = $derived.by(() => buildSparklineAreaPath(priceTrail, 460, 96, 1));
	const priceTrailChange = $derived.by(() => {
		if (priceTrail.length < 2) return 0;
		const first = priceTrail[0];
		const last = priceTrail[priceTrail.length - 1];
		if (!Number.isFinite(first) || first === 0) return 0;
		return ((last - first) / first) * 100;
	});
	const priceTrailLabel = $derived.by(() => {
		if (priceTrail.length < 2) return 'Collecting live ticks...';
		const sign = priceTrailChange > 0 ? '+' : '';
		return `${sign}${priceTrailChange.toFixed(2)}% · ${priceTrail.length} ticks`;
	});
	const priceTrailClass = $derived.by(() =>
		priceTrailChange > 0
			? 'text-success'
			: priceTrailChange < 0
				? 'text-error'
				: 'text-base-content/70'
	);
</script>

<section class="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
	<article class="card rounded-2xl border border-base-300 bg-base-200 shadow-sm xl:order-1">
		<div class="card-body gap-5 p-6">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">
						Total Volume (All-time)
					</p>
					<h2 class="card-title text-2xl md:text-3xl">
						{currency(snapshot.stats.totalVolumeAllTime)}
					</h2>
				</div>
				<div class="text-xl">📊</div>
			</div>

			<div class="space-y-2 text-sm">
				<div class="flex items-center justify-between">
					<span>{accountALabel}</span>
					<strong>{currency(snapshot.stats.totalVolumeAccountA)}</strong>
				</div>
				<div class="flex items-center justify-between">
					<span>{accountBLabel}</span>
					<strong>{currency(snapshot.stats.totalVolumeAccountB)}</strong>
				</div>
				<div class="flex items-center justify-between text-info">
					<span>Today</span>
					<strong>{currency(snapshot.stats.totalVolumeToday)}</strong>
				</div>
			</div>

			<div class="mt-auto flex justify-between text-xs text-base-content/70">
				<span>{snapshot.stats.cyclesCompleted} cycles completed</span>
				<span>{snapshot.updatedAt}</span>
			</div>
		</div>
	</article>

	<article class="card rounded-2xl border border-base-300 bg-base-200 shadow-sm xl:order-3">
		<div class="card-body gap-5 p-6">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">Total PnL</p>
					<div class="relative inline-flex items-center">
						<span
							aria-hidden="true"
							class={`absolute inset-0 z-0 translate-y-1 scale-110 bg-gradient-to-r from-error via-success to-error bg-clip-text text-3xl leading-none font-semibold text-transparent opacity-70 blur-2xl transition-all duration-300 md:text-4xl ${
								pnlVisible ? 'opacity-40 blur-3xl' : 'opacity-80 blur-2xl'
							}`}
						>
							{sessionPnlText}
						</span>
						<h2
							class={`relative z-10 card-title text-2xl font-semibold transition-[filter,transform,opacity,color] duration-300 md:text-3xl ${sessionPnlValueClass} ${
								pnlVisible ? 'blur-0 opacity-100' : 'opacity-80 blur-md'
							}`}
						>
							{sessionPnlText}
						</h2>
					</div>
				</div>
				<button
					type="button"
					class="btn h-10 w-10 rounded-full p-0 text-base-content/70 btn-ghost btn-sm hover:bg-base-300 hover:text-base-content"
					aria-label={sessionPnlRevealLabel}
					aria-pressed={pnlVisible}
					onclick={() => {
						pnlVisible = !pnlVisible;
					}}
				>
					{#if pnlVisible}
						<svg
							viewBox="0 0 24 24"
							class="h-5 w-5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M3.98 8.223A10.5 10.5 0 0 0 1.5 12s3.75 6.5 10.5 6.5c1.01 0 1.96-.126 2.84-.352"
							/>
							<path stroke-linecap="round" stroke-linejoin="round" d="M6.2 6.2 17.8 17.8" />
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M10.477 5.056A10.4 10.4 0 0 1 12 5.5c6.75 0 10.5 6.5 10.5 6.5a10.5 10.5 0 0 1-4.369 4.382"
							/>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M14.12 9.88A3 3 0 1 1 9.88 14.12"
							/>
						</svg>
					{:else}
						<svg
							viewBox="0 0 24 24"
							class="h-5 w-5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M2.25 12s3.75-6.5 9.75-6.5S21.75 12 21.75 12 18 18.5 12 18.5 2.25 12 2.25 12Z"
							/>
							<circle cx="12" cy="12" r="3" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					{/if}
				</button>
			</div>

			<div class="space-y-1 text-sm">
				<p
					class={`transition-[filter,opacity] duration-300 ${
						pnlVisible
							? 'blur-0 text-base-content opacity-100'
							: 'text-base-content/70 opacity-75 blur-md'
					}`}
				>
					{pnlVisible ? sessionCostsText : 'Fees: •••• · Gas: ••••'}
				</p>
				<p class="text-base-content/70">{uiRuntimeMessage}</p>
			</div>
		</div>
	</article>

	<article
		class="card rounded-2xl border border-base-300 bg-base-200 shadow-sm xl:order-2 xl:col-span-2"
	>
		<div class="card-body gap-5 p-6">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">SUI Price</p>
					<h2
						class={`card-title text-2xl transition-[color,transform,filter] duration-500 md:text-3xl ${priceValueClass}`}
						style={priceValueStyle}
					>
						{currency(animatedPrice.current, 4)}
					</h2>
				</div>
				<div class="text-xl">📈</div>
			</div>

			<div class="space-y-3 text-sm">
				<p class="text-base-content/70">Source: {snapshot.price.source}</p>
				<div
					class="flex items-center justify-between gap-3 text-base-content/70"
					aria-label="Time until next price refresh"
				>
					<span>Next update</span>
					<svg class="price-refresh-ring" viewBox="0 0 36 36" aria-hidden="true">
						<circle class="price-refresh-track" cx="18" cy="18" r="14"></circle>
						<circle
							class="price-refresh-value"
							cx="18"
							cy="18"
							r="14"
							stroke-dasharray={priceRingCircumference}
							stroke-dashoffset={priceRingOffset}
						></circle>
					</svg>
				</div>
				<div class="-mx-6 mt-1 -mb-6">
					<div class="rounded-b-2xl border border-base-300/80 bg-base-100/70 pt-2.5">
						<svg
							viewBox="0 0 460 96"
							class="h-24 w-full"
							role="img"
							aria-label="Realtime SUI mini chart"
						>
							<defs>
								<linearGradient id="suiChartArea" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stop-color="rgba(56,189,248,0.42)" />
									<stop offset="100%" stop-color="rgba(56,189,248,0.02)" />
								</linearGradient>
							</defs>
							{#if sparklineAreaPath}
								<path d={sparklineAreaPath} fill="url(#suiChartArea)"></path>
							{/if}
							{#if sparklinePath}
								<path
									d={sparklinePath}
									fill="none"
									stroke="rgb(56, 189, 248)"
									stroke-width="2.4"
									stroke-linecap="round"
									stroke-linejoin="round"
								></path>
							{/if}
						</svg>
						<div class="mt-1 flex items-center justify-between gap-2 px-6 pb-2.5 text-xs">
							<span class="text-base-content/65">Realtime micro chart</span>
							<span class={`tabular-nums ${priceTrailClass}`}>{priceTrailLabel}</span>
						</div>
					</div>
				</div>
				{#if streamError}
					<p class="text-warning">Realtime stream reconnecting...</p>
				{/if}
			</div>
		</div>
	</article>
</section>
