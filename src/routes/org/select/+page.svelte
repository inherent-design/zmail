<script lang="ts">
import { page } from "$app/state";
</script>

<section class="stack" data-testid="org-select">
	<h1>Select organization</h1>
	<p class="muted">Organization selection is handled by the Hono auth route.</p>
	<form method="post" action="/org/select" class="stack">
		<input
			name="organizationId"
			aria-label="Organization ID"
			autocomplete="organization"
		/>
		<input
			type="hidden"
			name="returnTo"
			value={page.url.searchParams.get("returnTo") ?? "/"}
		/>
		<button type="submit" class="button">Select</button>
	</form>
</section>
