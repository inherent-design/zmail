<script lang="ts">
import PageData from "$lib/components/PageData.svelte";

let { data } = $props();
</script>

<PageData title="Overseer" data={data.profile} />
