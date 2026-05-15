<script lang="ts">
import PageData from "$lib/components/PageData.svelte";

let { data } = $props();
</script>

<PageData title="Delete local account" data={data.deleteAccount} />
