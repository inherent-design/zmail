import { createFileRoute } from "@tanstack/react-router";
import { MessageDetailPage } from "#/app/pages/message-detail-page";
import { getMessageDetailData } from "#/app/server/actions";

export const Route = createFileRoute("/messages/$messageId")({
	loader: ({ params }) =>
		getMessageDetailData({ data: { messageId: params.messageId } }),
	component: () => {
		const data = Route.useLoaderData();
		return <MessageDetailPage data={data} />;
	},
});
