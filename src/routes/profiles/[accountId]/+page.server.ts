import { runWithOrgContext } from "#/lib/runtime";
import { loadProfileData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals, params }) => {
	depends(`zmail:profile:${params.accountId}`);
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		profile: await loadProfileData({ accountId: params.accountId }),
	}));
};
