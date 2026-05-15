<script lang="ts">
import DataInspector from "./DataInspector.svelte";

let {
	title,
	description,
	data,
}: { title: string; description?: string; data: unknown } = $props();
</script>

<section class="stack" data-testid="page-content">
	<header class="page-header">
		<h1>{title}</h1>
		{#if description}
			<p class="muted">{description}</p>
		{/if}
	</header>
	<DataInspector title={`${title} data`} value={data} />
</section>
