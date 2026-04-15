import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { OAuthReadinessCard } from "#/app/components/oauth-readiness-card";
import { beginGoogleReconnect } from "#/app/server/actions";

interface AccountReconnectPageData {
	account: {
		id: string;
		label: string;
		email_address: string;
		provider_kind: string;
		has_oauth_token: boolean;
		connection_state:
			| "connected"
			| "paused"
			| "needs_reconnect"
			| "disconnected";
	};
	has_oauth_token: boolean;
	connection_state:
		| "connected"
		| "paused"
		| "needs_reconnect"
		| "disconnected";
	oauthReady: boolean;
	missingVars: string[];
	redirectUrl: string;
}

export function AccountReconnectPage({
	data,
}: {
	data: AccountReconnectPageData;
}) {
	const startReconnect = useServerFn(beginGoogleReconnect);
	const [label, setLabel] = useState(data.account.label);
	const [status, setStatus] = useState<string | null>(null);

	return (
		<div className="page">
			<section className="card stack">
				<h1>Reconnect Gmail account</h1>
				<p className="muted">
					Reconnect Gmail OAuth for this account without rebinding it to a
					different Gmail identity.
				</p>
				<div className="row">
					<span className="pill">connection: {data.connection_state}</span>
					<span className="pill">
						OAuth token: {data.has_oauth_token ? "available" : "missing"}
					</span>
				</div>
			</section>

			<OAuthReadinessCard
				oauthReady={data.oauthReady}
				missingVars={data.missingVars}
				redirectUrl={data.redirectUrl}
			/>

			<section className="card stack">
				<h2>Reconnect</h2>
				<div className="form-grid">
					<label>
						Account label
						<input
							aria-label="Account label"
							className="input"
							value={label}
							onChange={(event) => setLabel(event.target.value)}
						/>
					</label>
					<label>
						Expected Gmail email
						<input
							aria-label="Expected Gmail email"
							className="input"
							value={data.account.email_address}
							readOnly
						/>
					</label>
				</div>
				<p className="muted">
					Use the same Gmail address during OAuth:{" "}
					<code>{data.account.email_address}</code>
				</p>
				<div className="actions">
					<button
						className="button"
						type="button"
						disabled={!data.oauthReady || !label.trim()}
						onClick={async () => {
							setStatus("redirecting to Google...");
							try {
								const result = await startReconnect({
									data: {
										accountId: data.account.id,
										label: label.trim(),
									},
								});
								window.location.href = result.url;
							} catch (error) {
								setStatus(
									`error: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}}
					>
						Reconnect Gmail
					</button>
					<Link
						className="button secondary"
						to="/accounts/$accountId"
						params={{ accountId: data.account.id }}
					>
						Back to account
					</Link>
				</div>
				{status ? <p className="muted">{status}</p> : null}
			</section>
		</div>
	);
}
