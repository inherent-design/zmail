<script lang="ts">
import PageData from "$lib/components/PageData.svelte";

let { data } = $props();
</script>

<PageData title="Messages" data={data.messages} />
