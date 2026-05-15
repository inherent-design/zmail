import { error } from "@sveltejs/kit";
import { runWithOrgContext } from "#/lib/runtime";
import { loadAccountDetailData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals, params }) => {
	depends("zmail:accounts");
	depends(`zmail:account:${params.accountId}`);
	return runWithOrgContext(locals.orgId ?? "local", async () => {
		if (!params.accountId) {
			error(400, "accountId is required");
		}
		return {
			account: await loadAccountDetailData({ accountId: params.accountId }),
		};
	});
};
