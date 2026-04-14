import { createFileRoute } from "@tanstack/react-router";

import { MessagesPage } from "#/app/pages/messages-page";
import { getMessagesData } from "#/app/server/actions";

export const Route = createFileRoute("/messages/")({
	loader: () => getMessagesData(),
	component: () => {
		const data = Route.useLoaderData();
		return <MessagesPage data={data} />;
	},
});
