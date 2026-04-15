import { Link } from "@tanstack/react-router";

interface AccountsPageData {
	accounts: Array<{
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
		sync_enabled: number;
		sync_status: string;
		last_synced_at: string | null;
		last_error: string | null;
		message_count: number;
		tombstone_count: number;
	}>;
}

const CONNECTION_STATE_LABEL: Record<
	AccountsPageData["accounts"][number]["connection_state"],
	string
> = {
	connected: "connected",
	paused: "paused",
	needs_reconnect: "needs_reconnect",
	disconnected: "disconnected",
};

export function AccountsPage({ data }: { data: AccountsPageData }) {
	return (
		<div className="page">
			<section className="card stack">
				<div className="row">
					<h1>Accounts</h1>
					<Link className="button" to="/accounts/new">
						Connect Gmail
					</Link>
				</div>
				<p className="muted">Connected email accounts and their sync status.</p>
			</section>

			<section className="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Label</th>
							<th>Email</th>
							<th>Provider</th>
							<th>Connection</th>
							<th>Sync</th>
							<th>Status</th>
							<th>Last synced</th>
							<th>Messages</th>
							<th>Last error</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{data.accounts.map((account) => (
							<tr key={account.id}>
								<td>
									<Link
										to="/accounts/$accountId"
										params={{ accountId: account.id }}
									>
										{account.label}
									</Link>
								</td>
								<td>{account.email_address}</td>
								<td>{account.provider_kind}</td>
								<td>{CONNECTION_STATE_LABEL[account.connection_state]}</td>
								<td>{account.sync_enabled ? "enabled" : "disabled"}</td>
								<td>{account.sync_status}</td>
								<td>{account.last_synced_at ?? "never"}</td>
								<td>{account.message_count}</td>
								<td>{account.last_error ?? "none"}</td>
								<td>
									{account.connection_state === "needs_reconnect" ||
									account.connection_state === "disconnected" ? (
										<Link
											to="/accounts/$accountId/reconnect"
											params={{ accountId: account.id }}
										>
											Reconnect
										</Link>
									) : (
										<span className="muted">None</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
