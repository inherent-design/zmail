<script lang="ts">
import { useToasts } from "$lib/client/toast-store.svelte";

const toasts = useToasts();
</script>

<div class="toast-region" aria-live="polite" data-testid="toast-region">
	{#each toasts.items as toast}
		<button
			type="button"
			class={`toast ${toast.tone}`}
			onclick={() => toasts.dismiss(toast.id)}
		>
			{toast.text}
		</button>
	{/each}
</div>
