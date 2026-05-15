<script lang="ts">
import { onMount } from "svelte";
import { connectRealtime } from "$lib/client/realtime";
import ShellNav from "$lib/components/ShellNav.svelte";
import ToastRegion from "$lib/components/ToastRegion.svelte";

let { data, children } = $props();

onMount(() => {
	return connectRealtime(["accounts", "finance", "jobs", "messages", "review"]);
});
</script>

<svelte:head>
	<link rel="stylesheet" href="/assets/styles.css" />
</svelte:head>

<div class="app-shell" data-testid="sveltekit-shell">
	<header class="topbar">
		<a class="brand" href="/">zmail</a>
		<ShellNav />
		<div class="muted">{data.principal?.email}</div>
	</header>
	<main id="app-main" class="main-shell">
		{@render children()}
	</main>
	<ToastRegion />
</div>
