import { runWithOrgContext } from "#/lib/runtime";
import { loadHomeData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals }) => {
	depends("zmail:home");
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		home: await loadHomeData(),
	}));
};
