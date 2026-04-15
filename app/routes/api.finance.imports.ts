import { createFileRoute } from "@tanstack/react-router";

import { queueImportFinanceArtifactCommand } from "#/app/server/actions.server";

export const Route = createFileRoute("/api/finance/imports")({
	component: () => null,
	server: {
		handlers: {
			POST: async ({ request }) => {
				const artifact = await request.json();
				const jobId = await queueImportFinanceArtifactCommand({ artifact });
				return Response.json(
					{
						ok: true,
						jobId,
					},
					{ status: 202 },
				);
			},
		},
	},
});
