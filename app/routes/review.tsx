import { createFileRoute } from "@tanstack/react-router";
import { ReviewPage } from "#/app/pages/review-page";
import { getReviewData } from "#/app/server/actions";

export const Route = createFileRoute("/review")({
	loader: () => getReviewData(),
	component: () => {
		const data = Route.useLoaderData();
		return <ReviewPage data={data} />;
	},
});
