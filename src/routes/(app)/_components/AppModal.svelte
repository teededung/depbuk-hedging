<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';

	type Props = {
		open: boolean;
		onClose: () => void;
		title?: string;
		maxWidth?: string;
		children: Snippet;
	};

	let { open, onClose, title = '', maxWidth = 'max-w-5xl', children }: Props = $props();

	let modalRef = $state<HTMLDivElement | null>(null);

	function handleBackdropClick(event: MouseEvent): void {
		if (event.target === event.currentTarget) {
			onClose();
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}

	function stopScroll(event: WheelEvent | TouchEvent): void {
		event.stopPropagation();
	}

	$effect(() => {
		if (open) {
			tick().then(() => {
				modalRef?.focus();
			});
		}
	});
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		bind:this={modalRef}
		role="dialog"
		aria-modal="true"
		aria-label={title || 'Modal'}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm sm:p-6"
		transition:fade={{ duration: 180 }}
		onclick={handleBackdropClick}
		tabindex="-1"
		data-theme="dark"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			role="document"
			class={`w-full ${maxWidth} max-h-[calc(100vh-2rem)] overflow-y-auto rounded-3xl border border-base-300 bg-base-100 shadow-2xl sm:max-h-[calc(100vh-3rem)]`}
			transition:fly={{ y: 16, duration: 220 }}
			onclick={(event) => event.stopPropagation()}
			onwheel={stopScroll}
			ontouchmove={stopScroll}
		>
			{@render children()}
		</div>
	</div>
{/if}
