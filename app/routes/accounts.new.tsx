import { createFileRoute } from "@tanstack/react-router";
import { AccountNewPage } from "#/app/pages/account-new-page";
import { getAccountNewData } from "#/app/server/actions";

export const Route = createFileRoute("/accounts/new")({
	loader: () => getAccountNewData(),
	component: () => {
		const data = Route.useLoaderData();
		return <AccountNewPage data={data} />;
	},
});
