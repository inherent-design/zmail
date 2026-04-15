interface OAuthReadinessCardProps {
	oauthReady: boolean;
	missingVars: string[];
	redirectUrl: string;
}

export function OAuthReadinessCard({
	oauthReady,
	missingVars,
	redirectUrl,
}: OAuthReadinessCardProps) {
	return (
		<section className="card stack">
			<h2>Environment readiness</h2>
			<p className="muted">Expected callback: {redirectUrl}</p>
			{oauthReady ? (
				<p className="pill">OAuth credentials configured</p>
			) : (
				<div className="stack">
					<p className="muted">Missing environment variables:</p>
					<ul>
						{missingVars.map((value) => (
							<li key={value}>{value}</li>
						))}
					</ul>
					<p className="muted">
						Start the app with <code>mise run dev</code> to load the
						repo-managed encrypted secrets, or export{" "}
						<code>GOOGLE_OAUTH_CLIENT_ID</code> and{" "}
						<code>GOOGLE_OAUTH_CLIENT_SECRET</code> manually.
					</p>
				</div>
			)}
		</section>
	);
}
