<script lang="ts">
import PageData from "$lib/components/PageData.svelte";

let { data } = $props();
</script>

<PageData title={data.message.message.subject ?? "Message"} data={data.message} />
