<script lang="ts">
import { page } from "$app/state";
</script>

<section class="stack" data-testid="org-claim-legacy">
	<h1>Claim legacy runtime</h1>
	<form method="post" action="/org/claim-legacy" class="stack">
		<input
			type="hidden"
			name="returnTo"
			value={page.url.searchParams.get("returnTo") ?? "/"}
		/>
		<button type="submit" class="button">Claim</button>
	</form>
</section>
