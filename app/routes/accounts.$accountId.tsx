import { createFileRoute } from "@tanstack/react-router";
import { AccountDetailPage } from "#/app/pages/account-detail-page";
import { getAccountDetailData } from "#/app/server/actions";

export const Route = createFileRoute("/accounts/$accountId")({
	loader: ({ params }) =>
		getAccountDetailData({ data: { accountId: params.accountId } }),
	component: () => {
		const data = Route.useLoaderData();
		return <AccountDetailPage data={data} />;
	},
});
