import { runWithOrgContext } from "#/lib/runtime";
import { loadAccountNewData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals }) => {
	depends("zmail:accounts");
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		accountForm: await loadAccountNewData(),
		mode: "connect",
	}));
};
