import { runWithOrgContext } from "#/lib/runtime";
import { loadMessageDetailData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals, params }) => {
	depends("zmail:messages");
	depends(`zmail:message:${params.messageId}`);
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		message: await loadMessageDetailData({ messageId: params.messageId }),
	}));
};
