import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { OAuthReadinessCard } from "#/app/components/oauth-readiness-card";
import { beginGoogleConnect } from "#/app/server/actions";

interface AccountNewPageData {
	oauthReady: boolean;
	missingVars: string[];
	redirectUrl: string;
}

export function AccountNewPage({ data }: { data: AccountNewPageData }) {
	const startConnect = useServerFn(beginGoogleConnect);
	const [label, setLabel] = useState("");
	const [status, setStatus] = useState<string | null>(null);

	return (
		<div className="page">
			<section className="card stack">
				<h1>Connect Gmail account</h1>
				<p className="muted">
					Link a Gmail account via Google OAuth for IMAP sync.
				</p>
			</section>

			<OAuthReadinessCard
				oauthReady={data.oauthReady}
				missingVars={data.missingVars}
				redirectUrl={data.redirectUrl}
			/>

			<section className="card stack">
				<h2>Connect</h2>
				<div className="form-grid">
					<label>
						Account label
						<input
							aria-label="Account label"
							className="input"
							value={label}
							onChange={(event) => setLabel(event.target.value)}
							placeholder="e.g. personal, work"
						/>
					</label>
				</div>
				<div className="actions">
					<button
						className="button"
						type="button"
						disabled={!data.oauthReady || !label.trim()}
						onClick={async () => {
							setStatus("redirecting to Google...");
							try {
								const result = await startConnect({
									data: { label: label.trim() },
								});
								window.location.href = result.url;
							} catch (err) {
								setStatus(
									`error: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}}
					>
						Connect Gmail
					</button>
				</div>
				{status ? <p className="muted">{status}</p> : null}
			</section>
		</div>
	);
}
