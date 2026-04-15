import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { completeGoogleConnect } from "#/app/server/actions";
import { completeGoogleConnectInputSchema } from "#/lib/schemas";

function CallbackError({ error }: { error: Error }) {
	return (
		<div className="page">
			<section className="card stack">
				<h1>Gmail connection failed</h1>
				<p className="muted">
					{error.message || "The OAuth callback could not be completed."}
				</p>
				<div className="actions">
					<Link className="button secondary" to="/accounts">
						Back to Accounts
					</Link>
					<Link className="button" to="/accounts/new">
						Back to Connect Gmail
					</Link>
				</div>
			</section>
		</div>
	);
}

export const Route = createFileRoute("/oauth/google/callback")({
	validateSearch: (search) => completeGoogleConnectInputSchema.parse(search),
	loaderDeps: ({ search }) => ({
		code: search.code,
		state: search.state,
	}),
	loader: async ({ deps }) => {
		const { accountId } = await completeGoogleConnect({ data: deps });
		throw redirect({
			to: "/accounts/$accountId",
			params: { accountId },
		});
	},
	component: () => (
		<div className="page">
			<section className="card stack">
				<h1>Processing Gmail connection...</h1>
			</section>
		</div>
	),
	errorComponent: ({ error }) => (
		<CallbackError
			error={error instanceof Error ? error : new Error(String(error))}
		/>
	),
});
