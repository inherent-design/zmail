import { runWithOrgContext } from "#/lib/runtime";
import { loadMessagesData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals, url }) => {
	depends("zmail:messages");
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		messages: await loadMessagesData({
			q: url.searchParams.get("q") ?? undefined,
			accountId: url.searchParams.get("accountId") ?? undefined,
			bucket: url.searchParams.get("bucket") ?? undefined,
			parseStatus: url.searchParams.get("parseStatus") ?? undefined,
			page: url.searchParams.get("page") ?? undefined,
			pageSize: url.searchParams.get("pageSize") ?? undefined,
		}),
	}));
};
