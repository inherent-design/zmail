import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { purgeAccount } from "#/app/server/actions";

interface AccountDeletePageData {
	account: {
		id: string;
		label: string;
		email_address: string;
		has_oauth_token: boolean;
		connection_state:
			| "connected"
			| "paused"
			| "needs_reconnect"
			| "disconnected";
	};
	messageCount: number;
	tombstoneCount: number;
	runningJobs: Array<{
		id: string;
		kind: string;
		status: string;
		created_at: string;
	}>;
}

export function AccountDeletePage({ data }: { data: AccountDeletePageData }) {
	const router = useRouter();
	const purge = useServerFn(purgeAccount);
	const [confirmationEmail, setConfirmationEmail] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const confirmationMatches =
		confirmationEmail === data.account.email_address &&
		data.runningJobs.length === 0 &&
		!isDeleting;

	return (
		<div className="page">
			<section className="card stack">
				<h1>Delete local account</h1>
				<p className="muted">
					This permanently removes the local Gmail account and mailbox-local
					state from zmail.
				</p>
				<div className="row">
					<span className="pill">{data.account.label}</span>
					<span className="pill">{data.account.email_address}</span>
					<span className="pill">connection: {data.account.connection_state}</span>
				</div>
				<div className="row muted">
					<span>Messages: {data.messageCount}</span>
					<span>Tombstones: {data.tombstoneCount}</span>
				</div>
			</section>

			<section className="card stack">
				<h2>This will delete</h2>
				<ul>
					<li>The account row and sync state.</li>
					<li>The local OAuth token and raw `.eml` storage for this account.</li>
					<li>Synced messages, sources, labels, reviews, and mailbox-local jobs.</li>
				</ul>
			</section>

			<section className="card stack">
				<h2>This will not delete</h2>
				<ul>
					<li>Other Gmail accounts.</li>
					<li>Operator registry files and imported registry rows.</li>
					<li>Global imported finance artifacts and taxonomy files.</li>
				</ul>
			</section>

			<section className="card stack">
				<h2>Confirmation</h2>
				{data.runningJobs.length > 0 ? (
					<div className="stack">
						<p className="muted">
							Account purge is blocked while account-scoped jobs are running.
						</p>
						<ul>
							{data.runningJobs.map((job) => (
								<li key={job.id}>
									{job.kind} ({job.status}) started {job.created_at}
								</li>
							))}
						</ul>
					</div>
				) : null}
				<label>
					Type the Gmail email to confirm deletion
					<input
						aria-label="Confirmation email"
						className="input"
						value={confirmationEmail}
						onChange={(event) => setConfirmationEmail(event.target.value)}
						placeholder={data.account.email_address}
					/>
				</label>
				<div className="actions">
					<button
						className="button"
						type="button"
						disabled={!confirmationMatches}
						onClick={async () => {
							setStatus("deleting local account...");
							setIsDeleting(true);
							try {
								await purge({
									data: {
										accountId: data.account.id,
										confirmationEmail,
									},
								});
								window.location.href = "/accounts";
							} catch (error) {
								setStatus(
									`error: ${error instanceof Error ? error.message : String(error)}`,
								);
								setIsDeleting(false);
							}
						}}
					>
						Delete local account
					</button>
					<Link
						className="button secondary"
						to="/accounts/$accountId"
						params={{ accountId: data.account.id }}
					>
						Back to account
					</Link>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await router.invalidate();
						}}
					>
						Refresh
					</button>
				</div>
				{status ? <p className="muted">{status}</p> : null}
			</section>
		</div>
	);
}
