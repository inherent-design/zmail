<script lang="ts">
import PageData from "$lib/components/PageData.svelte";

let { data } = $props();
</script>

<PageData
	title="zmail"
	description="Gmail live-sync analysis workspace."
	data={data.home}
/>
