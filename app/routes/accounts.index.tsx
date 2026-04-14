import { createFileRoute } from "@tanstack/react-router";

import { AccountsPage } from "#/app/pages/accounts-page";
import { getAccountsData } from "#/app/server/actions";

export const Route = createFileRoute("/accounts/")({
	loader: () => getAccountsData(),
	component: () => {
		const data = Route.useLoaderData();
		return <AccountsPage data={data} />;
	},
});
