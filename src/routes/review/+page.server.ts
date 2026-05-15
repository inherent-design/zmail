import { runWithOrgContext } from "#/lib/runtime";
import { loadReviewData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals }) => {
	depends("zmail:review");
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		review: await loadReviewData(),
	}));
};
