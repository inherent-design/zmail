import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import {
	disconnectAccount,
	pauseAccountSync,
	queueAccountClassifyBacklog,
	queueAccountDeltaSync,
	queueAccountFinanceBacklog,
	queueAccountFullSync,
	queueAccountReconcile,
	resumeAccountSync,
} from "#/app/server/actions";

interface AccountDetailPageData {
	account: {
		id: string;
		label: string;
		email_address: string;
		provider_kind: string;
		sync_enabled: number;
		sync_status: string;
		selected_mailbox: string;
		last_synced_at: string | null;
		last_error: string | null;
		created_at: string;
		updated_at: string;
	};
	syncState: {
		uidvalidity: number | null;
		latest_uid_cursor: number | null;
		earliest_uid_cursor: number | null;
		backfill_snapshot_uid: number | null;
		backfill_next_uid: number | null;
		last_bootstrap_started_at: string | null;
		last_bootstrap_completed_at: string | null;
		last_delta_sync_at: string | null;
		last_reconcile_at: string | null;
		last_backfill_sync_at: string | null;
		backfill_completed_at: string | null;
		watcher_status: string;
		consecutive_failures: number;
		backoff_until: string | null;
	} | null;
	recentJobs: Array<{
		id: string;
		kind: string;
		status: string;
		created_at: string;
		last_error: string | null;
	}>;
	messageCount: number;
	tombstoneCount: number;
	financeCoverage: {
		rootFinanceRelevantCount: number;
		totalHeads: number;
		readyCount: number;
		reviewCount: number;
		staleCount: number;
		blockedParseErrorCount: number;
		eventCandidateCount: number;
		documentCandidateCount: number;
	};
}

export function AccountDetailPage({ data }: { data: AccountDetailPageData }) {
	const router = useRouter();
	const fullSync = useServerFn(queueAccountFullSync);
	const deltaSync = useServerFn(queueAccountDeltaSync);
	const reconcile = useServerFn(queueAccountReconcile);
	const classifyBacklog = useServerFn(queueAccountClassifyBacklog);
	const classifyFinanceBacklog = useServerFn(queueAccountFinanceBacklog);
	const pause = useServerFn(pauseAccountSync);
	const resume = useServerFn(resumeAccountSync);
	const disconnect = useServerFn(disconnectAccount);

	const accountId = data.account.id;

	return (
		<div className="page">
			<section className="card stack">
				<h1>{data.account.label}</h1>
				<p className="muted">{data.account.email_address}</p>
				<div className="row">
					<span className="pill">{data.account.provider_kind}</span>
					<span className="pill">
						sync: {data.account.sync_enabled ? "enabled" : "disabled"}
					</span>
					<span className="pill">status: {data.account.sync_status}</span>
					<span className="pill">mailbox: {data.account.selected_mailbox}</span>
				</div>
				<div className="row muted">
					<span>Created: {data.account.created_at}</span>
					<span>Updated: {data.account.updated_at}</span>
					<span>Last synced: {data.account.last_synced_at ?? "never"}</span>
				</div>
				{data.account.last_error ? (
					<p className="muted">Last error: {data.account.last_error}</p>
				) : null}
			</section>

			<section className="card stack">
				<h2>Sync controls</h2>
				<div className="actions">
					<button
						className="button"
						type="button"
						onClick={async () => {
							await fullSync({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Full sync
					</button>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await deltaSync({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Delta sync
					</button>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await reconcile({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Reconcile
					</button>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await classifyBacklog({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Classify backlog
					</button>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await classifyFinanceBacklog({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Classify finance backlog
					</button>
					<Link
						className="button secondary"
						to="/profiles/$accountId"
						params={{ accountId }}
					>
						Open overseer
					</Link>
					<Link className="button secondary" to="/finance">
						Open finance
					</Link>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await pause({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Pause
					</button>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await resume({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Resume
					</button>
					<button
						className="button secondary"
						type="button"
						onClick={async () => {
							await disconnect({ data: { accountId } });
							await router.invalidate();
						}}
					>
						Disconnect
					</button>
				</div>
			</section>

			<section className="card stack">
				<h2>Statistics</h2>
				<div className="row">
					<div className="stat">
						<span className="muted">Messages</span>
						<strong>{data.messageCount}</strong>
					</div>
					<div className="stat">
						<span className="muted">Tombstones</span>
						<strong>{data.tombstoneCount}</strong>
					</div>
					<div className="stat">
						<span className="muted">Root finance relevant</span>
						<strong>{data.financeCoverage.rootFinanceRelevantCount}</strong>
					</div>
					<div className="stat">
						<span className="muted">Finance intel heads</span>
						<strong>{data.financeCoverage.totalHeads}</strong>
					</div>
					<div className="stat">
						<span className="muted">Finance candidates</span>
						<strong>
							{data.financeCoverage.eventCandidateCount +
								data.financeCoverage.documentCandidateCount}
						</strong>
					</div>
				</div>
				<div className="row">
					<span className="pill">ready: {data.financeCoverage.readyCount}</span>
					<span className="pill">
						review: {data.financeCoverage.reviewCount}
					</span>
					<span className="pill">stale: {data.financeCoverage.staleCount}</span>
					<span className="pill">
						parse blocked: {data.financeCoverage.blockedParseErrorCount}
					</span>
					<span className="pill">
						events: {data.financeCoverage.eventCandidateCount}
					</span>
					<span className="pill">
						documents: {data.financeCoverage.documentCandidateCount}
					</span>
				</div>
			</section>

			{data.syncState ? (
				<section className="card stack">
					<h2>Cursor state</h2>
					<div className="row">
						<span className="pill">
							uidvalidity: {String(data.syncState.uidvalidity ?? "unknown")}
						</span>
						<span className="pill">
							latest uid:{" "}
							{String(data.syncState.latest_uid_cursor ?? "unknown")}
						</span>
						<span className="pill">
							earliest uid:{" "}
							{String(data.syncState.earliest_uid_cursor ?? "unknown")}
						</span>
						<span className="pill">
							backfill next:{" "}
							{String(data.syncState.backfill_next_uid ?? "complete")}
						</span>
						<span className="pill">
							backfill snapshot:{" "}
							{String(data.syncState.backfill_snapshot_uid ?? "unknown")}
						</span>
						<span className="pill">
							watcher: {data.syncState.watcher_status}
						</span>
						<span className="pill">
							sync status: {data.account.sync_status}
						</span>
						<span className="pill">
							failures: {data.syncState.consecutive_failures}
						</span>
					</div>
					<div className="row muted">
						<span>
							Bootstrap started:{" "}
							{data.syncState.last_bootstrap_started_at ?? "never"}
						</span>
						<span>
							Bootstrap completed:{" "}
							{data.syncState.last_bootstrap_completed_at ?? "never"}
						</span>
						<span>
							Delta sync: {data.syncState.last_delta_sync_at ?? "never"}
						</span>
						<span>
							Reconcile: {data.syncState.last_reconcile_at ?? "never"}
						</span>
						<span>
							Backfill sync: {data.syncState.last_backfill_sync_at ?? "never"}
						</span>
						<span>
							Backfill completed:{" "}
							{data.syncState.backfill_completed_at ?? "never"}
						</span>
					</div>
					{data.syncState.backoff_until ? (
						<p className="muted">
							Backoff until: {data.syncState.backoff_until}
						</p>
					) : null}
				</section>
			) : null}

			<section className="card stack">
				<h2>Recent jobs</h2>
				{data.recentJobs.length === 0 ? (
					<p className="muted">No recent jobs.</p>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Kind</th>
									<th>Status</th>
									<th>Created</th>
									<th>Last error</th>
								</tr>
							</thead>
							<tbody>
								{data.recentJobs.map((job) => (
									<tr key={job.id}>
										<td>{job.kind}</td>
										<td>{job.status}</td>
										<td>{job.created_at}</td>
										<td>{job.last_error ?? "none"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
