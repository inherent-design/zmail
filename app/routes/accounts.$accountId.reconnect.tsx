import { createFileRoute } from "@tanstack/react-router";

import { AccountReconnectPage } from "#/app/pages/account-reconnect-page";
import { getAccountReconnectData } from "#/app/server/actions";

export const Route = createFileRoute("/accounts/$accountId/reconnect")({
	loader: ({ params }) =>
		getAccountReconnectData({ data: { accountId: params.accountId } }),
	component: () => {
		const data = Route.useLoaderData();
		return <AccountReconnectPage data={data} />;
	},
});
