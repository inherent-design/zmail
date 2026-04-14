import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "#/app/pages/runs-page";
import { getRunsData } from "#/app/server/actions";

export const Route = createFileRoute("/runs")({
	loader: () => getRunsData(),
	component: () => {
		const data = Route.useLoaderData();
		return <RunsPage data={data} />;
	},
});
