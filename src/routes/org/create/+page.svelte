<script lang="ts">
import { page } from "$app/state";
</script>

<section class="stack" data-testid="org-create">
	<h1>Create organization</h1>
	<form method="post" action="/org/create" class="stack">
		<input
			name="organizationName"
			aria-label="Organization name"
			autocomplete="organization"
			required
		/>
		<input
			type="hidden"
			name="returnTo"
			value={page.url.searchParams.get("returnTo") ?? "/"}
		/>
		<button type="submit" class="button">Create</button>
	</form>
</section>
