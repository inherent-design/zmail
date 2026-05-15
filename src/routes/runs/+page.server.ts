import { runWithOrgContext } from "#/lib/runtime";
import { loadRunsData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals }) => {
	depends("zmail:runs");
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		runs: await loadRunsData(),
	}));
};
