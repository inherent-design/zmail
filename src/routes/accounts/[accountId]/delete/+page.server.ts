import { runWithOrgContext } from "#/lib/runtime";
import { loadAccountDeleteData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals, params }) => {
	depends(`zmail:account:${params.accountId}`);
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		deleteAccount: await loadAccountDeleteData({ accountId: params.accountId }),
	}));
};
