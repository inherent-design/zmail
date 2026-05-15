<script lang="ts">
import { page } from "$app/state";

const items = [
	{ href: "/", label: "Home" },
	{ href: "/accounts", label: "Accounts" },
	{ href: "/messages", label: "Messages" },
	{ href: "/review", label: "Review" },
	{ href: "/finance", label: "Finance" },
	{ href: "/runs", label: "Runs" },
];
</script>

<nav class="shell-nav" aria-label="Primary">
	{#each items as item}
		<a
			href={item.href}
			aria-current={page.url.pathname === item.href ? "page" : undefined}
		>
			{item.label}
		</a>
	{/each}
</nav>
