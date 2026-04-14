import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "#/app/pages/home-page";
import { getHomeData } from "#/app/server/actions";

export const Route = createFileRoute("/")({
	loader: () => getHomeData(),
	component: () => {
		const data = Route.useLoaderData();
		return <HomePage data={data} />;
	},
});
