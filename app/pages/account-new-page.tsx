import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

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

			<section className="card stack">
				<h2>Environment readiness</h2>
				<p className="muted">Expected callback: {data.redirectUrl}</p>
				{data.oauthReady ? (
					<p className="pill">OAuth credentials configured</p>
				) : (
					<div className="stack">
						<p className="muted">Missing environment variables:</p>
						<ul>
							{data.missingVars.map((v) => (
								<li key={v}>{v}</li>
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
