<script lang="ts">
import PageData from "$lib/components/PageData.svelte";

let { data } = $props();
</script>

<PageData title="Finance" data={data.finance} />
