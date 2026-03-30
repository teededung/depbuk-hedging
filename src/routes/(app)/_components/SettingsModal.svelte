<script lang="ts">
	import type { RuntimeSnapshot } from '$lib/types/bot.js';
	import type { SettingsForm } from '../_helpers/page-view.js';
	import { formatDateTime } from '../_helpers/page-view.js';
	import AppModal from './AppModal.svelte';

	type SettingsErrors = Record<'general' | 'cycle' | 'execution' | 'accounts', string | null>;

	type Props = {
		open: boolean;
		onClose: () => void;
		snapshot: RuntimeSnapshot;
		settingsPending: boolean;
		settingsSaving: boolean;
		settingsError: string | null;
		settingsSuccess: string | null;
		settingsErrors: SettingsErrors;
		settingsForm: SettingsForm;
		onSave: () => void;
	};

	let {
		open,
		onClose,
		snapshot,
		settingsPending,
		settingsSaving,
		settingsError,
		settingsSuccess,
		settingsErrors,
		settingsForm = $bindable(),
		onSave
	}: Props = $props();

	let leverageMode = $state<'both' | 'custom'>('both');
	let lastOpen = $state(false);

	const sharedLeverage = $derived(
		settingsForm.account_a_borrow_quote_factor === settingsForm.account_b_borrow_base_factor
			? settingsForm.account_a_borrow_quote_factor
			: settingsForm.account_a_borrow_quote_factor
	);

	$effect(() => {
		if (open && !lastOpen) {
			leverageMode =
				settingsForm.account_a_borrow_quote_factor === settingsForm.account_b_borrow_base_factor
					? 'both'
					: 'custom';
		}
		lastOpen = open;
	});

	function setLeverageMode(next: 'both' | 'custom') {
		leverageMode = next;
		if (next === 'both') {
			const unifiedLeverage =
				settingsForm.account_a_borrow_quote_factor ||
				settingsForm.account_b_borrow_base_factor ||
				2;
			settingsForm.account_a_borrow_quote_factor = unifiedLeverage;
			settingsForm.account_b_borrow_base_factor = unifiedLeverage;
		}
	}

	function updateSharedLeverage(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		settingsForm.account_a_borrow_quote_factor = value;
		settingsForm.account_b_borrow_base_factor = value;
	}

	function slippagePercentValue(value: number): string {
		if (!Number.isFinite(value)) {
			return '';
		}
		return (value * 100).toFixed(3).replace(/\.?0+$/, '');
	}

	function updateSlippagePercent(event: Event) {
		const raw = (event.currentTarget as HTMLInputElement).value;
		if (raw === '') {
			settingsForm.slippage_tolerance = Number.NaN;
			return;
		}

		settingsForm.slippage_tolerance = Number(raw) / 100;
	}

	function updateOpenOrderExecutionMode(event: Event) {
		settingsForm.open_order_execution_mode = (event.currentTarget as HTMLSelectElement)
			.value as SettingsForm['open_order_execution_mode'];
	}

	function updateCloseOrderExecutionMode(event: Event) {
		settingsForm.close_order_execution_mode = (event.currentTarget as HTMLSelectElement)
			.value as SettingsForm['close_order_execution_mode'];
	}
</script>

<AppModal {open} {onClose} title="Runtime configuration" maxWidth="max-w-5xl">
	<div class="bg-base-100">
		<div class="flex items-start justify-between gap-4 border-b border-base-300 px-6 py-5">
			<div class="space-y-2">
				<p class="text-xs tracking-[0.14em] text-base-content/70 uppercase">Bot Settings</p>
				<h3 class="text-2xl font-semibold">Runtime configuration</h3>
			</div>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose} type="button">✕</button>
		</div>

		<div class="space-y-5 px-6 py-6 text-sm text-base-content">
			{#if settingsPending}
				<div class="card border border-base-300 bg-base-200 shadow-sm">
					<div
						class="card-body flex flex-col items-center justify-center gap-4 px-6 py-10 text-center"
					>
						<span class="loading loading-lg loading-spinner text-info"></span>
						<div class="space-y-2">
							<p class="text-base font-medium">Loading saved settings...</p>
							<p class="text-sm text-base-content/70">
								Fetching the current DB-backed bot configuration.
							</p>
						</div>
					</div>
				</div>
			{:else}
				<div class="flex flex-wrap items-start justify-between gap-4">
					<div class="space-y-2">
						<p class="text-sm text-base-content/75">
							Settings are stored in Postgres. Saving while the bot is running will apply on the
							next restart.
						</p>
						{#if snapshot.config?.settingsApplyPending}
							<p class="badge badge-outline">Saved settings are pending restart</p>
						{/if}
					</div>
					<p class="badge badge-outline">Updated {formatDateTime(settingsForm.updated_at)}</p>
				</div>

				{#if settingsError}
					<div class="alert alert-soft alert-error">{settingsError}</div>
				{/if}
				{#if settingsSuccess}
					<div class="alert alert-soft alert-success">{settingsSuccess}</div>
				{/if}

				<div class="grid gap-4 xl:grid-cols-2">
					<article class="card border border-base-300 bg-base-200 shadow-sm xl:col-span-2">
						<div class="card-body gap-4">
							<div>
								<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">General</p>
								<h4 class="card-title">Network and routing</h4>
							</div>
							<div class="space-y-4">
								<div class="grid gap-4 md:grid-cols-2">
									<label class="floating-label">
										<span>Network</span>
										<input
											class="input w-full"
											placeholder="Mainnet"
											value={settingsForm.network === 'mainnet' ? 'Mainnet' : settingsForm.network}
											readonly
										/>
									</label>
									<label class="floating-label">
										<span>Pool key</span>
										<input
											class="input w-full"
											placeholder="SUI_USDC"
											bind:value={settingsForm.pool_key}
										/>
									</label>
									<fieldset class="fieldset md:col-span-2">
										<legend class="fieldset-legend">RPC endpoints</legend>
										<textarea
											class="textarea h-28 w-full font-mono text-xs"
											placeholder={'https://fullnode.mainnet.sui.io:443\nhttps://sui-rpc.publicnode.com/'}
											bind:value={settingsForm.rpc_url}
											spellcheck="false"
										></textarea>
										<p class="label">
											One URL per line. Runtime rotates write traffic and falls back across RPCs for
											reads.
										</p>
									</fieldset>
									<label class="floating-label md:col-span-2">
										<span>DeepTrade orderbook API</span>
										<input
											class="input w-full"
											placeholder="https://api.deeptrade.space/api"
											bind:value={settingsForm.deeptrade_orderbook_api_base}
										/>
									</label>
								</div>
								{#if settingsErrors.general}
									<p class="label text-error">{settingsErrors.general}</p>
								{/if}
							</div>
						</div>
					</article>

					<article class="card border border-base-300 bg-base-200 shadow-sm">
						<div class="card-body gap-4">
							<div>
								<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">Cycle</p>
								<h4 class="card-title">Sizing and hold window</h4>
							</div>
							<div class="space-y-4">
								<div class="grid gap-4 md:grid-cols-2">
									<label class="floating-label">
										<span>Notional size (USD)</span>
										<input
											type="number"
											step="0.0001"
											class="input w-full"
											placeholder="4"
											bind:value={settingsForm.notional_size_usd}
										/>
									</label>
									<fieldset class="fieldset">
										<label class="floating-label">
											<span>Auto-reduce floor (%)</span>
											<input
												type="number"
												min="1"
												max="100"
												step="1"
												class="input w-full"
												placeholder="100"
												bind:value={settingsForm.notional_auto_reduce_floor_pct}
											/>
										</label>
										<p class="label">
											Minimum allowed size: ~${(
												((settingsForm.notional_size_usd || 0) *
													(settingsForm.notional_auto_reduce_floor_pct || 100)) /
												100
											).toFixed(2)}
										</p>
									</fieldset>
									<label class="floating-label">
										<span>Max cycles</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="3"
											value={settingsForm.max_cycles ?? ''}
											oninput={(event) => {
												const value = (event.currentTarget as HTMLInputElement).value;
												settingsForm.max_cycles = value ? Number(value) : null;
											}}
										/>
									</label>
									<label class="floating-label">
										<span>Min hold (s)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="150"
											bind:value={settingsForm.min_hold_seconds}
										/>
									</label>
									<label class="floating-label">
										<span>Max hold (s)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="210"
											bind:value={settingsForm.max_hold_seconds}
										/>
									</label>
									<label class="floating-label">
										<span>Slippage tolerance (%)</span>
										<input
											type="number"
											min="0.1"
											max="10"
											step="0.1"
											class="input w-full"
											placeholder="0.5"
											value={slippagePercentValue(settingsForm.slippage_tolerance)}
											oninput={updateSlippagePercent}
										/>
									</label>
									<label class="floating-label">
										<span>Random size (bps)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="200"
											bind:value={settingsForm.random_size_bps}
										/>
									</label>
								</div>
								{#if settingsErrors.cycle}
									<p class="label text-error">{settingsErrors.cycle}</p>
								{/if}
							</div>
						</div>
					</article>

					<article class="card border border-base-300 bg-base-200 shadow-sm">
						<div class="card-body gap-4">
							<div>
								<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">Execution</p>
								<h4 class="card-title">Retries, delay, and auto-swap</h4>
							</div>
							<div class="space-y-4">
								<div class="grid min-w-0 gap-4 md:grid-cols-2">
									<fieldset class="fieldset min-w-0">
										<legend class="fieldset-legend">Open order mode</legend>
										<select
											class="select max-w-full"
											value={settingsForm.open_order_execution_mode}
											onchange={updateOpenOrderExecutionMode}
										>
											<option value="limit">Limit (maker)</option>
											<option value="market">Market (taker)</option>
										</select>
									</fieldset>
									<fieldset class="fieldset min-w-0">
										<legend class="fieldset-legend">Close order mode</legend>
										<select
											class="select max-w-full"
											value={settingsForm.close_order_execution_mode}
											onchange={updateCloseOrderExecutionMode}
										>
											<option value="limit">Limit (maker)</option>
											<option value="market">Market (taker)</option>
										</select>
									</fieldset>
									<label class="floating-label min-w-0">
										<span>Min order delay (ms)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="600"
											bind:value={settingsForm.min_order_delay_ms}
										/>
									</label>
									<label class="floating-label min-w-0">
										<span>Max order delay (ms)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="1400"
											bind:value={settingsForm.max_order_delay_ms}
										/>
									</label>
									<label class="floating-label min-w-0">
										<span>Order poll interval (ms)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="2500"
											bind:value={settingsForm.order_poll_interval_ms}
										/>
									</label>
									<label class="floating-label min-w-0">
										<span>Maker reprice (s)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="30"
											bind:value={settingsForm.maker_reprice_seconds}
										/>
									</label>
									<div class="min-w-0">
										<label class="floating-label min-w-0">
											<span>Force market close (s)</span>
											<input
												type="number"
												step="1"
												class="input w-full"
												placeholder="20"
												bind:value={settingsForm.force_market_close_seconds}
												disabled={settingsForm.close_order_execution_mode === 'market'}
											/>
										</label>
									</div>
									<label class="floating-label min-w-0">
										<span>Auto-swap buffer (bps)</span>
										<input
											type="number"
											step="1"
											class="input w-full"
											placeholder="500"
											bind:value={settingsForm.auto_swap_buffer_bps}
										/>
									</label>
									<p class="label break-words whitespace-normal text-base-content/70 md:col-span-2">
										`Auto-swap` now prepares each wallet into its target asset: `Account A`
										swaps into `SUI`, while `Account B` swaps into `USDC`.
									</p>
									<label class="floating-label min-w-0">
										<span>Min gas reserve (SUI)</span>
										<input
											type="number"
											step="0.0001"
											class="input w-full"
											placeholder="0.15"
											bind:value={settingsForm.min_gas_reserve_sui}
										/>
									</label>
									<label class="flex cursor-pointer items-center gap-3">
										<input
											type="checkbox"
											class="toggle toggle-primary toggle-sm"
											bind:checked={settingsForm.auto_swap_enabled}
										/>
										<span>Enable auto-swap top-up</span>
									</label>
								</div>
								{#if settingsErrors.execution}
									<p class="label text-error">{settingsErrors.execution}</p>
								{/if}
							</div>
						</div>
					</article>

					<article class="card border border-base-300 bg-base-200 shadow-sm xl:col-span-2">
						<div class="card-body gap-4">
							<div>
								<p class="text-xs tracking-[0.14em] text-base-content/65 uppercase">Accounts</p>
								<h4 class="card-title">Labels, keys, and margin managers</h4>
							</div>
							<div class="space-y-4">
								<div class="grid gap-4 lg:grid-cols-2">
									<fieldset class="fieldset">
										<legend class="fieldset-legend">Account A label</legend>
										<input
											class="input w-full"
											placeholder="Account A (Long)"
											bind:value={settingsForm.account_a_label}
										/>
									</fieldset>
									<fieldset class="fieldset">
										<legend class="fieldset-legend">Account B label</legend>
										<input
											class="input w-full"
											placeholder="Account B (Short)"
											bind:value={settingsForm.account_b_label}
										/>
									</fieldset>
								</div>
								<div class="grid gap-4 lg:grid-cols-2">
									<fieldset class="fieldset">
										<legend class="fieldset-legend">Private key A</legend>
										<input
											type="password"
											class="input w-full"
											placeholder="suiprivkey..."
											bind:value={settingsForm.private_key_A}
										/>
										{#if settingsForm.has_private_key_a}
											<p class="label">
												<span class="badge badge-soft badge-success">Encrypted key is stored</span>
											</p>
										{/if}
									</fieldset>
									<fieldset class="fieldset">
										<legend class="fieldset-legend">Private key B</legend>
										<input
											type="password"
											class="input w-full"
											placeholder="suiprivkey..."
											bind:value={settingsForm.private_key_B}
										/>
										{#if settingsForm.has_private_key_b}
											<p class="label">
												<span class="badge badge-soft badge-success">Encrypted key is stored</span>
											</p>
										{/if}
									</fieldset>
								</div>
								<div class="grid gap-4">
									<fieldset class="fieldset">
										<legend class="fieldset-legend">Account A margin manager ID</legend>
										<input
											class="input w-full"
											placeholder="0x..."
											value={settingsForm.account_a_margin_manager_id ?? ''}
											oninput={(event) => {
												settingsForm.account_a_margin_manager_id =
													(event.currentTarget as HTMLInputElement).value.trim() || undefined;
											}}
										/>
									</fieldset>
									<fieldset class="fieldset">
										<legend class="fieldset-legend">Account B margin manager ID</legend>
										<input
											class="input w-full"
											placeholder="0x..."
											value={settingsForm.account_b_margin_manager_id ?? ''}
											oninput={(event) => {
												settingsForm.account_b_margin_manager_id =
													(event.currentTarget as HTMLInputElement).value.trim() || undefined;
											}}
										/>
									</fieldset>
								</div>
								<div class="space-y-4 rounded-box bg-base-100 p-4">
									<div class="flex flex-wrap items-center justify-between gap-3">
										<div>
											<p class="text-sm font-medium">Leverage</p>
											<p class="text-xs text-base-content/65">
												Use one leverage for both accounts or tune them separately. `2 = x2`.
											</p>
										</div>
										<div class="join">
											<button
												class={`btn join-item btn-sm ${leverageMode === 'both' ? 'btn-primary' : 'btn-ghost'}`}
												type="button"
												onclick={() => setLeverageMode('both')}
											>
												Both
											</button>
											<button
												class={`btn join-item btn-sm ${leverageMode === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
												type="button"
												onclick={() => setLeverageMode('custom')}
											>
												Custom
											</button>
										</div>
									</div>

									{#if leverageMode === 'both'}
										<fieldset class="fieldset">
											<legend class="fieldset-legend">Leverage (both accounts)</legend>
											<input
												type="number"
												step="0.0001"
												class="input w-full"
												placeholder="2"
												value={sharedLeverage}
												oninput={updateSharedLeverage}
											/>
											<p class="label">Applied to both Account A and Account B.</p>
										</fieldset>
									{:else}
										<div class="grid gap-4 lg:grid-cols-2">
											<fieldset class="fieldset">
												<legend class="fieldset-legend">Account A leverage</legend>
												<input
													type="number"
													step="0.0001"
													class="input w-full"
												placeholder="2"
												bind:value={settingsForm.account_a_borrow_quote_factor}
											/>
											<p class="label">Maps to SUI collateral funding for the long account.</p>
										</fieldset>
											<fieldset class="fieldset">
												<legend class="fieldset-legend">Account B leverage</legend>
												<input
													type="number"
													step="0.0001"
													class="input w-full"
													placeholder="2"
													bind:value={settingsForm.account_b_borrow_base_factor}
												/>
												<p class="label">Maps to short collateral funding for the short account.</p>
											</fieldset>
										</div>
									{/if}
								</div>
								{#if settingsErrors.accounts}
									<p class="label text-error">{settingsErrors.accounts}</p>
								{/if}
							</div>
						</div>
					</article>
				</div>
			{/if}
		</div>

		<div class="flex items-center justify-end gap-3 border-t border-base-300 px-6 py-5">
			<button class="btn btn-ghost btn-sm" onclick={onClose} type="button">Close</button>
			<button
				class="btn btn-sm btn-primary"
				onclick={onSave}
				disabled={settingsPending || settingsSaving}
			>
				{settingsSaving ? 'Saving...' : 'Save settings'}
			</button>
		</div>
	</div>
</AppModal>
