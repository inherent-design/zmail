import { createFileRoute } from "@tanstack/react-router";

import { FinancePage } from "#/app/pages/finance-page";
import { getFinanceData } from "#/app/server/actions";
import { financeDataInputSchema } from "#/lib/schemas";

export const Route = createFileRoute("/finance")({
	validateSearch: (search) =>
		financeDataInputSchema.parse({
			...search,
			year:
				typeof search.year === "string"
					? Number.parseInt(search.year, 10)
					: search.year,
		}),
	loaderDeps: ({ search }) => search,
	loader: (input) =>
		getFinanceData({
			data: input?.deps ?? financeDataInputSchema.parse({}),
		}),
	component: () => {
		const data = Route.useLoaderData();
		return <FinancePage data={data} />;
	},
});
