import { createFileRoute } from "@tanstack/react-router";

import { AccountDeletePage } from "#/app/pages/account-delete-page";
import { getAccountDeleteData } from "#/app/server/actions";

export const Route = createFileRoute("/accounts/$accountId/delete")({
	loader: ({ params }) =>
		getAccountDeleteData({ data: { accountId: params.accountId } }),
	component: () => {
		const data = Route.useLoaderData();
		return <AccountDeletePage data={data} />;
	},
});
