import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "#/app/pages/profile-page";
import { getProfileData } from "#/app/server/actions";

export const Route = createFileRoute("/profiles/$accountId")({
	loader: ({ params }) =>
		getProfileData({ data: { accountId: params.accountId } }),
	component: () => {
		const data = Route.useLoaderData();
		return <ProfilePage data={data} />;
	},
});
