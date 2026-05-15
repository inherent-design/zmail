import { runWithOrgContext } from "#/lib/runtime";
import { normalizeFinanceFilterSourceKind } from "#/lib/schemas";
import { loadFinanceData } from "#/server/actions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, locals, url }) => {
	depends("zmail:finance");
	let sourceKind:
		| ReturnType<typeof normalizeFinanceFilterSourceKind>
		| undefined;
	try {
		const raw = url.searchParams.get("sourceKind");
		sourceKind = raw ? normalizeFinanceFilterSourceKind(raw) : undefined;
	} catch {
		sourceKind = undefined;
	}
	return runWithOrgContext(locals.orgId ?? "local", async () => ({
		finance: await loadFinanceData({
			year: url.searchParams.get("year")
				? Number.parseInt(String(url.searchParams.get("year")), 10)
				: undefined,
			accountId: url.searchParams.get("accountId") ?? undefined,
			institutionId: url.searchParams.get("institutionId") ?? undefined,
			ownerIdentityId: url.searchParams.get("ownerIdentityId") ?? undefined,
			sourceKind,
			drilldown: url.searchParams.get("drilldown"),
		}),
	}));
};
