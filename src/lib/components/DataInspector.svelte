<script lang="ts">
let { title = "Data", value }: { title?: string; value: unknown } = $props();
</script>

<details class="data-inspector" data-testid="data-inspector">
	<summary>{title}</summary>
	<pre>{JSON.stringify(value, null, 2)}</pre>
</details>
