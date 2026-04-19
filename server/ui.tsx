/** @jsxImportSource hono/jsx */

import { appPath, assetPath, loadResolvedConfig } from "#/lib/app-config";
import { isGoogleOAuthBootstrapErrorMessage } from "#/lib/google-oauth";
import type {
	loadAccountDeleteData,
	loadAccountDetailData,
	loadAccountNewData,
	loadAccountReconnectData,
	loadAccountsData,
	loadFinanceData,
	loadHomeData,
	loadMessageDetailData,
	loadMessagesData,
	loadProfileData,
	loadReviewData,
	loadRunsData,
} from "#/server/actions";
import type { loadOrgSelectionData } from "#/server/auth";

const CLIENT_CONFIG = loadResolvedConfig();

type HomePageData = Awaited<ReturnType<typeof loadHomeData>>;
type OrgSelectionPageData = Awaited<ReturnType<typeof loadOrgSelectionData>>;
type AccountsPageData = Awaited<ReturnType<typeof loadAccountsData>>;
type AccountDetailPageData = Awaited<ReturnType<typeof loadAccountDetailData>>;
type AccountNewPageData = Awaited<ReturnType<typeof loadAccountNewData>>;
type AccountReconnectPageData = Awaited<
	ReturnType<typeof loadAccountReconnectData>
>;
type AccountDeletePageData = Awaited<ReturnType<typeof loadAccountDeleteData>>;
type MessagesPageData = Awaited<ReturnType<typeof loadMessagesData>>;
type MessageDetailPageData = Awaited<ReturnType<typeof loadMessageDetailData>>;
type ReviewPageData = Awaited<ReturnType<typeof loadReviewData>>;
type FinancePageData = Awaited<ReturnType<typeof loadFinanceData>>;
type ProfilePageData = Awaited<ReturnType<typeof loadProfileData>>;
type RunsPageData = Awaited<ReturnType<typeof loadRunsData>>;
type RunMeta = {
	processed?: number;
	total?: number;
	backendUsed?: string;
	lastErrorMessage?: string;
};

function json(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function href(path: string) {
	return appPath(path);
}

export function DocumentShell(input: {
	title: string;
	page: string;
	eventCursor: number;
	children: unknown;
}) {
	return (
		<html
			lang="en"
			data-page={input.page}
			data-zmail-base-path={CLIENT_CONFIG.server.basePath}
			data-zmail-event-cursor={String(input.eventCursor)}
		>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{input.title}</title>
				<link rel="stylesheet" href={assetPath("/assets/styles.css")} />
			</head>
			<body>
				<div class="shell">
					<header class="topbar">
						<div class="brand">zmail</div>
						<nav class="nav">
							<a href={href("/")}>Home</a>
							<a href={href("/accounts")}>Accounts</a>
							<a href={href("/messages")}>Messages</a>
							<a href={href("/review")}>Review</a>
							<a href={href("/finance")}>Finance</a>
							<a href={href("/runs")}>Runs</a>
						</nav>
					</header>
					<main
						id="app-main"
						class="page"
						data-page={input.page}
						data-event-cursor={String(input.eventCursor)}
					>
						{input.children}
					</main>
				</div>
				<script type="module" src={assetPath("/client/app.js")}></script>
			</body>
		</html>
	);
}

export function PartialMain(input: {
	page: string;
	eventCursor: number;
	children: unknown;
}) {
	return (
		<div
			id="app-main"
			class="page"
			data-page={input.page}
			data-event-cursor={String(input.eventCursor)}
		>
			{input.children}
		</div>
	);
}

function JsonBlock(input: { value: unknown }) {
	return <pre class="json-block">{json(input.value)}</pre>;
}

function Pill(input: { children: unknown }) {
	return <span class="pill">{input.children}</span>;
}

function prettyConnectionState(
	value:
		| "connected"
		| "config_error"
		| "paused"
		| "needs_reconnect"
		| "disconnected",
) {
	switch (value) {
		case "config_error":
			return "Config error";
		case "needs_reconnect":
			return "Needs reconnect";
		case "disconnected":
			return "Disconnected";
		case "paused":
			return "Paused";
		default:
			return "Connected";
	}
}

function Button(input: {
	label: string;
	action?: string;
	payload?: unknown;
	variant?: "primary" | "secondary";
	attrs?: Record<string, string>;
}) {
	return (
		<button
			type="button"
			class={input.variant === "secondary" ? "button secondary" : "button"}
			data-rpc={input.action ? appPath(input.action) : undefined}
			data-payload={input.payload ? JSON.stringify(input.payload) : undefined}
			{...(input.attrs ?? {})}
		>
			{input.label}
		</button>
	);
}

export function renderHomePage(data: HomePageData) {
	return (
		<>
			<section class="card stack">
				<h1>zmail</h1>
				<p class="muted">Gmail live-sync analysis workspace.</p>
			</section>
			<section class="stats">
				<div class="stat">
					<span class="muted">Accounts</span>
					<strong>{String(data.accounts ?? 0)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Messages</span>
					<strong>{String(data.messages ?? 0)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Open reviews</span>
					<strong>{String(data.openReviews ?? 0)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Jobs</span>
					<strong>{String(data.jobs ?? 0)}</strong>
				</div>
			</section>
			<section class="card stack">
				<div class="actions">
					<a class="button" href={href("/accounts/new")}>
						Connect Gmail
					</a>
					<a class="button" href={href("/accounts")}>
						Go to accounts
					</a>
					<a class="button secondary" href={href("/messages")}>
						Browse messages
					</a>
					<a class="button secondary" href={href("/review")}>
						Review low confidence
					</a>
				</div>
			</section>
		</>
	);
}

export function renderOrgSelectPage(data: OrgSelectionPageData) {
	return (
		<>
			<section class="card stack">
				<h1>Select organization</h1>
				<p class="muted">
					Signed in as {data.principal.email}. Choose the organization to open
					in this browser session.
				</p>
			</section>
			<section class="card stack">
				<form
					method="post"
					action={href(
						`/org/select?returnTo=${encodeURIComponent(data.returnTo)}`,
					)}
				>
					<div class="stack">
						{data.memberships.map((membership) => (
							<label key={membership.organizationId} class="row">
								<input
									type="radio"
									name="organizationId"
									value={membership.organizationId}
								/>
								<span>
									<strong>{membership.organizationName}</strong>
									{" · "}
									<span class="muted">{membership.role}</span>
								</span>
							</label>
						))}
					</div>
					<div class="actions">
						<button type="submit" class="button">
							Open organization
						</button>
						<a
							class="button secondary"
							href={href(
								`/org/create?returnTo=${encodeURIComponent(data.returnTo)}`,
							)}
						>
							Create new organization
						</a>
					</div>
				</form>
			</section>
		</>
	);
}

export function renderOrgCreatePage(
	data: Pick<OrgSelectionPageData, "principal" | "returnTo">,
) {
	return (
		<>
			<section class="card stack">
				<h1>Create organization</h1>
				<p class="muted">
					Signed in as {data.principal.email}. Create the organization that
					should own this zmail runtime.
				</p>
			</section>
			<section class="card stack">
				<form
					method="post"
					action={href(
						`/org/create?returnTo=${encodeURIComponent(data.returnTo)}`,
					)}
				>
					<label>
						Organization name
						<input
							class="input"
							type="text"
							name="organizationName"
							placeholder="e.g. Inherent Design"
						/>
					</label>
					<div class="actions">
						<button type="submit" class="button">
							Create organization
						</button>
					</div>
				</form>
			</section>
		</>
	);
}

export function renderOrgClaimLegacyPage(data: {
	orgId: string;
	returnTo: string;
}) {
	return (
		<>
			<section class="card stack">
				<h1>Claim legacy runtime</h1>
				<p class="muted">
					A legacy single-tenant runtime was found under <code>data/</code>.
					Claim it into organization <code>{data.orgId}</code> before opening
					org-scoped pages.
				</p>
			</section>
			<section class="card stack">
				<h2>This will move</h2>
				<ul>
					<li>
						<code>data/zmail.sqlite*</code>
					</li>
					<li>
						<code>data/accounts/</code>
					</li>
					<li>
						<code>data/operator/</code>
					</li>
				</ul>
				<form
					method="post"
					action={href(
						`/org/claim-legacy?returnTo=${encodeURIComponent(data.returnTo)}`,
					)}
				>
					<div class="actions">
						<button type="submit" class="button">
							Claim legacy runtime
						</button>
						<a class="button secondary" href={data.returnTo}>
							Cancel
						</a>
					</div>
				</form>
			</section>
		</>
	);
}

export function renderAccountsPage(
	data: AccountsPageData,
	options?: {
		canConnect?: boolean;
		canManageLifecycle?: (ownerPrincipalEmail: string | null) => boolean;
	},
) {
	return (
		<>
			<section class="card stack">
				<div class="row">
					<h1>Accounts</h1>
					{options?.canConnect === false ? null : (
						<a class="button" href={href("/accounts/new")}>
							Connect Gmail
						</a>
					)}
				</div>
				<p class="muted">Connected email accounts and their sync status.</p>
			</section>
			<section class="card table-wrap">
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
						{data.accounts.map((account) => {
							const canManageLifecycle =
								options?.canManageLifecycle?.(
									account.owner_principal_email ?? null,
								) ?? false;
							return (
								<tr key={account.id}>
									<td>
										<a href={href(`/accounts/${account.id}`)}>
											{account.label}
										</a>
									</td>
									<td>{account.email_address}</td>
									<td>{account.provider_kind}</td>
									<td>{prettyConnectionState(account.connection_state)}</td>
									<td>{account.sync_enabled ? "enabled" : "disabled"}</td>
									<td>{account.sync_status}</td>
									<td>{account.last_synced_at ?? "never"}</td>
									<td>{String(account.message_count)}</td>
									<td>{account.last_error ?? "none"}</td>
									<td>
										{account.connection_state === "config_error" &&
										canManageLifecycle ? (
											<a href={href(`/accounts/${account.id}/reconnect`)}>
												Retry after config fix
											</a>
										) : (account.connection_state === "needs_reconnect" ||
												account.connection_state === "disconnected") &&
											canManageLifecycle ? (
											<a href={href(`/accounts/${account.id}/reconnect`)}>
												Reconnect
											</a>
										) : (
											<span class="muted">None</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</section>
		</>
	);
}

export function renderAccountDetailPage(
	data: AccountDetailPageData,
	options: {
		canManageLifecycle: boolean;
		canOperate: boolean;
	},
) {
	const account = data.account;
	const accountId = account.id;
	return (
		<>
			<section class="card stack">
				<h1>{account.label}</h1>
				<p class="muted">{account.email_address}</p>
				<div class="row">
					<Pill>{account.provider_kind}</Pill>
					<Pill>
						connection: {prettyConnectionState(data.connection_state)}
					</Pill>
					<Pill>sync: {account.sync_enabled ? "enabled" : "disabled"}</Pill>
					<Pill>status: {account.sync_status}</Pill>
					<Pill>token: {data.has_oauth_token ? "present" : "missing"}</Pill>
				</div>
				{account.last_error ? (
					<p class="muted">Last error: {account.last_error}</p>
				) : null}
			</section>
			<section class="card stack">
				<h2>Connection status</h2>
				<p>{prettyConnectionState(data.connection_state)}</p>
				<div class="row">
					<Pill>{data.connection_state}</Pill>
					<Pill>
						watcher: {data.syncState?.watcher_status ?? "not_initialized"}
					</Pill>
				</div>
				<div class="actions" data-page-actions="account-detail">
					{account.connection_state === "connected" && options.canOperate ? (
						<>
							<Button
								label="Full sync"
								action={`/rpc/accounts/${accountId}/sync/full`}
							/>
							<Button
								label="Delta sync"
								action={`/rpc/accounts/${accountId}/sync/delta`}
								variant="secondary"
							/>
							<Button
								label="Reconcile"
								action={`/rpc/accounts/${accountId}/sync/reconcile`}
								variant="secondary"
							/>
							<Button
								label="Pause"
								action={`/rpc/accounts/${accountId}/pause`}
								variant="secondary"
							/>
						</>
					) : null}
					{account.connection_state === "connected" &&
					options.canManageLifecycle ? (
						<Button
							label="Disconnect Gmail"
							action={`/rpc/accounts/${accountId}/disconnect`}
							variant="secondary"
						/>
					) : null}
					{account.connection_state === "paused" && options.canOperate ? (
						<Button
							label="Resume"
							action={`/rpc/accounts/${accountId}/resume`}
							variant="secondary"
						/>
					) : null}
					{account.connection_state === "paused" &&
					options.canManageLifecycle ? (
						<Button
							label="Disconnect Gmail"
							action={`/rpc/accounts/${accountId}/disconnect`}
							variant="secondary"
						/>
					) : null}
					{account.connection_state === "config_error" &&
					options.canManageLifecycle ? (
						<a class="button" href={href(`/accounts/${accountId}/reconnect`)}>
							Retry after config fix
						</a>
					) : (account.connection_state === "needs_reconnect" ||
							account.connection_state === "disconnected") &&
						options.canManageLifecycle ? (
						<a class="button" href={href(`/accounts/${accountId}/reconnect`)}>
							Reconnect Gmail
						</a>
					) : null}
					{options.canOperate ? (
						<>
							<Button
								label="Classify backlog"
								action={`/rpc/accounts/${accountId}/classify/root`}
								variant="secondary"
							/>
							<Button
								label="Classify finance backlog"
								action={`/rpc/accounts/${accountId}/classify/finance`}
								variant="secondary"
							/>
							<a class="button secondary" href={href(`/profiles/${accountId}`)}>
								Open overseer
							</a>
						</>
					) : null}
					<a class="button secondary" href={href("/finance")}>
						Open finance
					</a>
				</div>
			</section>
			<section class="card stack">
				<h2>Sync progress</h2>
				<div class="stats">
					<div class="stat">
						<span class="muted">Phase</span>
						<strong>{data.syncProgress.phase}</strong>
					</div>
					<div class="stat">
						<span class="muted">Progress</span>
						<strong>
							{formatProgress(
								data.syncProgress.processed,
								data.syncProgress.total,
							)}
						</strong>
					</div>
					<div class="stat">
						<span class="muted">ETA</span>
						<strong>{formatEta(data.syncProgress.etaSeconds)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Remaining UID span</span>
						<strong>{String(data.syncProgress.remaining ?? "n/a")}</strong>
					</div>
				</div>
				<div class="row">
					<Pill>status: {data.syncProgress.status}</Pill>
					<Pill>updated: {data.syncProgress.updatedAt ?? "n/a"}</Pill>
				</div>
			</section>
			<section class="card stack">
				<h2>Statistics</h2>
				<div class="stats">
					<div class="stat">
						<span class="muted">Messages</span>
						<strong>{String(data.messageCount)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Tombstones</span>
						<strong>{String(data.tombstoneCount)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Finance heads</span>
						<strong>{String(data.financeCoverage.totalHeads)}</strong>
					</div>
				</div>
			</section>
			<section class="card stack">
				<h2>Recent jobs</h2>
				<table>
					<thead>
						<tr>
							<th>Kind</th>
							<th>Status</th>
							<th>Created</th>
							<th>Error</th>
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
			</section>
			<section class="card stack">
				<h2>Danger zone</h2>
				{options.canManageLifecycle ? (
					<>
						<p class="muted">
							This removes the local Gmail account and mailbox-local state. It
							does not remove other accounts, global registry data, or global
							imported finance artifacts.
						</p>
						<a
							class="button secondary"
							href={href(`/accounts/${accountId}/delete`)}
						>
							Delete local account
						</a>
					</>
				) : (
					<p class="muted">
						Account deletion is restricted to the account owner or an org admin.
					</p>
				)}
			</section>
		</>
	);
}

export function renderAccountFormPage(
	input:
		| {
				mode: "connect";
				data: AccountNewPageData;
		  }
		| {
				mode: "reconnect";
				data: AccountReconnectPageData;
		  },
) {
	const reconnectData = input.mode === "reconnect" ? input.data : null;
	const account = reconnectData?.account ?? null;
	const showsBootstrapError =
		Boolean(account?.last_error) &&
		isGoogleOAuthBootstrapErrorMessage(account?.last_error);
	return (
		<>
			<section class="card stack">
				<h1>
					{reconnectData ? "Reconnect Gmail account" : "Connect Gmail account"}
				</h1>
				<p class="muted">
					{reconnectData
						? "Reconnect Gmail OAuth for this account without rebinding it to a different Gmail identity."
						: "Link a Gmail account via Google OAuth for IMAP sync."}
				</p>
			</section>
			<section class="card stack">
				<h2>OAuth readiness</h2>
				<p class="muted">
					{input.data.oauthReady
						? "OAuth credentials are configured."
						: "OAuth credentials are missing."}
				</p>
				{input.data.missingVars?.length ? (
					<ul>
						{input.data.missingVars.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				) : null}
				<p class="muted">Redirect URL: {input.data.redirectUrl}</p>
				{showsBootstrapError && account?.last_error ? (
					<>
						<p>{account.last_error}</p>
						<p class="muted">
							Reconnect will keep failing until the Google OAuth client
							credentials are fixed.
						</p>
					</>
				) : null}
			</section>
			<section class="card stack" data-page-actions="account-form">
				<h2>{reconnectData ? "Reconnect" : "Connect"}</h2>
				<div class="form-grid">
					<label>
						Account label
						<input
							class="input"
							name="label"
							value={account?.label ?? ""}
							placeholder="e.g. personal, work"
							data-account-label
						/>
					</label>
					{reconnectData ? (
						<label>
							Expected Gmail email
							<input
								class="input"
								value={account?.email_address ?? ""}
								readOnly
								data-expected-email
							/>
						</label>
					) : null}
				</div>
				<div class="actions">
					<Button
						label={
							reconnectData && showsBootstrapError
								? "Retry after config fix"
								: reconnectData
									? "Reconnect Gmail"
									: "Connect Gmail"
						}
						action={
							account
								? `/rpc/accounts/${account.id}/reconnect`
								: "/rpc/accounts/connect/google"
						}
						attrs={
							account
								? {
										"data-account-id": account.id,
									}
								: undefined
						}
					/>
					{account ? (
						<a class="button secondary" href={href(`/accounts/${account.id}`)}>
							Back to account
						</a>
					) : null}
				</div>
				<p class="muted" data-form-status></p>
			</section>
		</>
	);
}

export function renderAccountDeletePage(data: AccountDeletePageData) {
	return (
		<>
			<section class="card stack">
				<h1>Delete local account</h1>
				<p class="muted">
					This permanently removes the local Gmail account and mailbox-local
					state from zmail.
				</p>
				<div class="row">
					<Pill>{data.account.label}</Pill>
					<Pill>{data.account.email_address}</Pill>
					<Pill>connection: {data.account.connection_state}</Pill>
				</div>
				<div class="row muted">
					<span>Messages: {String(data.messageCount)}</span>
					<span>Tombstones: {String(data.tombstoneCount)}</span>
				</div>
			</section>
			<section class="card stack">
				<h2>This will delete</h2>
				<ul>
					<li>The account row and sync state.</li>
					<li>
						The local OAuth token and raw `.eml` storage for this account.
					</li>
					<li>
						Synced messages, sources, labels, reviews, and mailbox-local jobs.
					</li>
				</ul>
			</section>
			<section class="card stack">
				<h2>This will not delete</h2>
				<ul>
					<li>Other Gmail accounts.</li>
					<li>Operator registry files and imported registry rows.</li>
					<li>Global imported finance artifacts and taxonomy files.</li>
				</ul>
			</section>
			<section class="card stack" data-page-actions="account-delete">
				<h2>Confirmation</h2>
				{data.runningJobs.length > 0 ? (
					<div class="stack">
						<p class="muted">
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
					Confirmation email
					<input
						class="input"
						data-confirmation-email
						placeholder={data.account.email_address}
					/>
				</label>
				<p class="muted">Type the Gmail email to confirm deletion.</p>
				<div class="actions">
					<Button
						label="Delete local account"
						action={`/rpc/accounts/${data.account.id}/delete`}
						attrs={{
							"data-account-id": data.account.id,
							"data-expected-email": data.account.email_address,
							"data-disabled-by-default": "true",
						}}
					/>
					<a
						class="button secondary"
						href={href(`/accounts/${data.account.id}`)}
					>
						Back to account
					</a>
					<a
						class="button secondary"
						href={href(`/accounts/${data.account.id}/delete`)}
					>
						Refresh
					</a>
				</div>
				<p class="muted" data-delete-status></p>
			</section>
		</>
	);
}

function messagesHref(filters: MessagesPageData["filters"], page: number) {
	const params = new URLSearchParams();
	if (filters.q) {
		params.set("q", filters.q);
	}
	if (filters.accountId) {
		params.set("accountId", filters.accountId);
	}
	if (filters.bucket) {
		params.set("bucket", filters.bucket);
	}
	if (filters.parseStatus) {
		params.set("parseStatus", filters.parseStatus);
	}
	params.set("pageSize", String(filters.pageSize));
	params.set("page", String(page));
	return href(`/messages?${params.toString()}`);
}

export function renderMessagesPage(rows: MessagesPageData) {
	const summary =
		rows.pagination.total === 1
			? "1 message"
			: `${String(rows.pagination.total)} messages`;
	return (
		<>
			<section class="card stack">
				<h1>Messages</h1>
				<p class="muted">
					{summary}. Page {String(rows.pagination.page)} of{" "}
					{String(rows.pagination.totalPages)}.
				</p>
				<form method="get" action={href("/messages")} class="form-grid">
					<label>
						Search
						<input
							class="input"
							type="search"
							name="q"
							value={rows.filters.q ?? ""}
							placeholder="Subject, sender, or body"
						/>
					</label>
					<label>
						Account
						<select name="accountId">
							<option value="">All accounts</option>
							{rows.options.accounts.map((account) => (
								<option
									key={account.id}
									value={account.id}
									selected={rows.filters.accountId === account.id}
								>
									{account.label}
								</option>
							))}
						</select>
					</label>
					<label>
						Bucket
						<select name="bucket">
							<option value="">All buckets</option>
							<option
								value="unlabeled"
								selected={rows.filters.bucket === "unlabeled"}
							>
								Unlabeled
							</option>
							{rows.options.buckets.map((bucket) => (
								<option
									key={bucket}
									value={bucket}
									selected={rows.filters.bucket === bucket}
								>
									{bucket}
								</option>
							))}
						</select>
					</label>
					<label>
						Parse status
						<select name="parseStatus">
							<option value="">Any status</option>
							<option
								value="parsed"
								selected={rows.filters.parseStatus === "parsed"}
							>
								Parsed
							</option>
							<option
								value="error"
								selected={rows.filters.parseStatus === "error"}
							>
								Parse error
							</option>
						</select>
					</label>
					<label>
						Page size
						<select name="pageSize">
							{rows.options.pageSizes.map((pageSize) => (
								<option
									key={pageSize}
									value={String(pageSize)}
									selected={rows.filters.pageSize === pageSize}
								>
									{String(pageSize)}
								</option>
							))}
						</select>
					</label>
					<div class="actions">
						<button type="submit" class="button">
							Apply
						</button>
						<a class="button secondary" href={href("/messages")}>
							Clear
						</a>
					</div>
				</form>
				<div class="actions">
					<a
						class={
							rows.pagination.hasPreviousPage
								? "button secondary"
								: "button secondary disabled"
						}
						href={
							rows.pagination.hasPreviousPage
								? messagesHref(rows.filters, rows.pagination.page - 1)
								: undefined
						}
					>
						Previous
					</a>
					<a
						class={
							rows.pagination.hasNextPage
								? "button secondary"
								: "button secondary disabled"
						}
						href={
							rows.pagination.hasNextPage
								? messagesHref(rows.filters, rows.pagination.page + 1)
								: undefined
						}
					>
						Next
					</a>
				</div>
			</section>
			<section class="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Date</th>
							<th>Account</th>
							<th>Sender</th>
							<th>Subject</th>
							<th>Conversation</th>
							<th>Extraction</th>
							<th>Bucket</th>
							<th>Flags</th>
						</tr>
					</thead>
					<tbody>
						{rows.rows.map((row) => (
							<tr key={row.id}>
								<td>{row.received_at ?? "unknown"}</td>
								<td>{row.account_label}</td>
								<td>{row.sender_address ?? "unknown"}</td>
								<td>
									<a href={href(`/messages/${row.id}`)}>
										{row.subject ?? "(no subject)"}
									</a>
								</td>
								<td>{row.remote_thread_id ?? row.conversation_id ?? "none"}</td>
								<td>{row.body_extraction_strategy}</td>
								<td>{row.primary_bucket ?? "unlabeled"}</td>
								<td>
									<div class="row">
										{row.has_forwarded ? <Pill>Forwarded</Pill> : null}
										{row.parse_status === "error" ? (
											<Pill>Parse error</Pill>
										) : null}
										{row.nsfw ? <Pill>NSFW</Pill> : null}
										{row.low_confidence ? <Pill>Low confidence</Pill> : null}
									</div>
								</td>
							</tr>
						))}
						{rows.rows.length === 0 ? (
							<tr>
								<td colspan={8}>No messages match current filters.</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</section>
		</>
	);
}

export function renderMessageDetailPage(data: MessageDetailPageData) {
	return (
		<>
			<section class="card stack" data-page-actions="message-detail">
				<div class="row">
					<h1>{data.message.subject ?? "(no subject)"}</h1>
					<Button
						label="Classify now"
						action={`/rpc/messages/${data.message.id}/classify`}
					/>
				</div>
				<div class="row muted">
					<span>{data.message.account_label}</span>
					<span>{data.message.received_at ?? "unknown date"}</span>
					<span>{data.message.sender_address ?? "unknown sender"}</span>
				</div>
			</section>
			<section class="two-up">
				<div class="stack">
					<div class="card stack">
						<h2>Primary body</h2>
						<pre class="json-block">
							{data.message.body_text_primary || "(empty)"}
						</pre>
					</div>
					{data.message.body_text_forwarded ? (
						<div class="card stack">
							<h2>Forwarded body</h2>
							<pre class="json-block">{data.message.body_text_forwarded}</pre>
						</div>
					) : null}
					<div class="card stack">
						<h2>Classifier/search body</h2>
						<pre class="json-block">
							{data.message.body_text_normalized || "(empty)"}
						</pre>
					</div>
					<div class="card stack">
						<h2>Current label</h2>
						<JsonBlock value={data.currentLabel?.label ?? null} />
					</div>
					<div class="card stack">
						<h2>Finance intel</h2>
						<JsonBlock value={data.financeIntel} />
					</div>
				</div>
				<div class="stack">
					<div class="card stack">
						<h2>Metadata</h2>
						<JsonBlock value={data.message} />
					</div>
					<div class="card stack">
						<h2>Attachments</h2>
						<JsonBlock value={data.attachments} />
					</div>
					<div class="card stack">
						<h2>Moderation</h2>
						<JsonBlock value={data.moderation} />
					</div>
					<div class="card stack">
						<h2>Latest overseer profile</h2>
						<JsonBlock value={data.latestProfile} />
					</div>
				</div>
			</section>
		</>
	);
}

export function renderReviewPage(rows: ReviewPageData) {
	return (
		<>
			<section class="card stack">
				<h1>Low-confidence review</h1>
				<p class="muted">Open reviews only.</p>
			</section>
			{rows.map((row) => (
				<section key={row.id} class="card stack" data-review-id={row.id}>
					<div class="row">
						<strong>{row.subject ?? "(no subject)"}</strong>
						<Pill>{row.sender_address ?? "unknown sender"}</Pill>
						<Pill>{row.body_extraction_strategy}</Pill>
						{row.has_forwarded ? <Pill>Forwarded</Pill> : null}
						{row.parse_status === "error" ? <Pill>Parse error</Pill> : null}
					</div>
					<p>{row.snippet}</p>
					{row.parse_status === "error" && row.parse_error_reason ? (
						<p class="muted">Parse issue: {row.parse_error_reason}</p>
					) : null}
					<JsonBlock value={row.result} />
					<label>
						Override JSON
						<textarea rows={14} data-override-json>
							{json(row.result)}
						</textarea>
					</label>
					<p class="muted" data-review-error></p>
					<div class="actions" data-page-actions="review">
						<Button
							label="Accept"
							action={`/rpc/reviews/${row.id}/resolve`}
							payload={{ action: "accept" }}
							variant="secondary"
						/>
						<Button
							label="Override"
							action={`/rpc/reviews/${row.id}/resolve`}
							payload={{ action: "override" }}
						/>
					</div>
				</section>
			))}
		</>
	);
}

function money(minor: number) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(minor / 100);
}

function filterHref(
	current: URLSearchParams,
	name: string,
	value: string | null,
) {
	const params = new URLSearchParams(current);
	if (value) {
		params.set(name, value);
	} else {
		params.delete(name);
	}
	return href(`/finance?${params.toString()}`);
}

export function renderFinancePage(
	data: FinancePageData,
	currentSearch: URLSearchParams,
) {
	const tabKeys = ["overview", "ledger", "imports", "exports", "review"];
	const requestedTab = currentSearch.get("tab") ?? "overview";
	const activeTab = tabKeys.includes(requestedTab) ? requestedTab : "overview";
	const tabHref = (tab: string) => {
		const params = new URLSearchParams(currentSearch);
		params.set("tab", tab);
		return href(`/finance?${params.toString()}`);
	};
	const warnings: string[] = [];
	if (!data.registry.importedAt) {
		warnings.push("Registry has not been imported yet.");
	}
	if (
		data.pipelineStatus.financeV3HeadCount <
		data.pipelineStatus.financeHeadCount
	) {
		warnings.push("Finance heads include stale non-v3 results.");
	}
	if (
		data.pipelineStatus.financeHeadCount <
		data.pipelineStatus.rootFinanceRelevantCount
	) {
		warnings.push(
			"Finance classifier coverage is incomplete for root finance rows.",
		);
	}
	if (
		!data.pipelineStatus.knowledgeMaterialized &&
		data.pipelineStatus.financeV3HeadCount > 0
	) {
		warnings.push("Ledger staging tables are still empty.");
	}

	return (
		<>
			<section class="card stack" data-page-actions="finance">
				<div class="row">
					<h1>Finance knowledge</h1>
					<div class="actions">
						<Button
							label="Import registry"
							action="/rpc/finance/registry/import"
						/>
						<Button
							label="Reconcile suggestions"
							action="/rpc/finance/suggestions/reconcile"
							variant="secondary"
						/>
						<Button
							label="Rebuild knowledge"
							action="/rpc/finance/knowledge/rebuild"
							variant="secondary"
						/>
						<Button
							label="Rebuild rollups"
							action="/rpc/finance/rollups/rebuild"
							variant="secondary"
						/>
					</div>
				</div>
				<div class="row">
					<Pill>year: {String(data.year)}</Pill>
					<Pill>registry: {data.registry.importedAt ?? "missing"}</Pill>
					<Pill>
						v3 heads: {String(data.pipelineStatus.financeV3HeadCount)}
					</Pill>
					<Pill>ledger: {String(data.pipelineStatus.ledgerEntryCount)}</Pill>
				</div>
				{warnings.length ? (
					<div class="stack">
						{warnings.map((warning) => (
							<p key={warning} class="muted">
								Warning: {warning}
							</p>
						))}
					</div>
				) : null}
				<nav class="tabs">
					{tabKeys.map((tab) => (
						<a
							key={tab}
							class={activeTab === tab ? "tab active" : "tab"}
							href={tabHref(tab)}
						>
							{tab}
						</a>
					))}
				</nav>
			</section>
			<section class="card stack">
				<h2>Filters</h2>
				<div class="stack">
					<div class="row">
						<strong>Year filter</strong>
						{data.availableYears.map((year) => (
							<a
								key={year}
								href={filterHref(currentSearch, "year", String(year))}
							>
								{year}
							</a>
						))}
					</div>
					<div class="row">
						<strong>Account filter</strong>
						<a href={filterHref(currentSearch, "accountId", null)}>All</a>
						{data.filters.accounts.map((row) => (
							<a
								key={row.id}
								href={filterHref(currentSearch, "accountId", row.id)}
							>
								{row.label}
							</a>
						))}
					</div>
					<div class="row">
						<strong>Institution filter</strong>
						<a href={filterHref(currentSearch, "institutionId", null)}>All</a>
						{data.filters.institutions.map((row) => (
							<a
								key={row.id}
								href={filterHref(currentSearch, "institutionId", row.id)}
							>
								{row.label}
							</a>
						))}
					</div>
					<div class="row">
						<strong>Identity filter</strong>
						<a href={filterHref(currentSearch, "ownerIdentityId", null)}>All</a>
						{data.filters.ownerIdentities.map((row) => (
							<a
								key={row.id}
								href={filterHref(currentSearch, "ownerIdentityId", row.id)}
							>
								{row.label}
							</a>
						))}
					</div>
					<div class="row">
						<strong>Source filter</strong>
						<a href={filterHref(currentSearch, "sourceKind", null)}>All</a>
						{data.filters.sourceKinds.map((kind) => (
							<a
								key={kind}
								href={filterHref(currentSearch, "sourceKind", kind)}
							>
								{kind}
							</a>
						))}
					</div>
					{currentSearch.get("accountId") ||
					currentSearch.get("institutionId") ||
					currentSearch.get("ownerIdentityId") ||
					currentSearch.get("sourceKind") ? (
						<div class="row">
							<a
								href={href(
									`/finance?tab=${activeTab}&year=${String(data.year)}`,
								)}
							>
								Clear filters
							</a>
						</div>
					) : null}
				</div>
			</section>
			<section class="stats">
				<div class="stat">
					<span class="muted">Inflow</span>
					<strong>{money(data.summary.inflowMinor)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Outflow</span>
					<strong>{money(data.summary.outflowMinor)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Net</span>
					<strong>{money(data.summary.netMinor)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Transactions</span>
					<strong>{String(data.summary.extractedTransactionCount)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Ready</span>
					<strong>{String(data.pipelineStatus.ledgerReadyCount)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Review</span>
					<strong>{String(data.pipelineStatus.ledgerReviewCount)}</strong>
				</div>
			</section>

			{activeTab === "overview" ? (
				<>
					<section class="card stack">
						<h2>Rollups</h2>
						<table>
							<thead>
								<tr>
									<th>Source</th>
									<th>Category</th>
									<th>Inflow</th>
									<th>Outflow</th>
									<th>Net</th>
									<th>Count</th>
								</tr>
							</thead>
							<tbody>
								{data.rollups.map((row, index) => (
									<tr key={`${row.primaryCategory}:${index}`}>
										<td>{row.sourceKind}</td>
										<td>{row.primaryCategory}</td>
										<td>{money(row.inflowMinor)}</td>
										<td>{money(row.outflowMinor)}</td>
										<td>{money(row.netMinor)}</td>
										<td>{String(row.transactionCount)}</td>
									</tr>
								))}
								{data.rollups.length === 0 ? (
									<tr>
										<td colspan={6}>No rollups for current filters.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
					<section class="card stack">
						<h2>Patterns</h2>
						<table>
							<thead>
								<tr>
									<th>Kind</th>
									<th>Key</th>
									<th>Status</th>
									<th>Confidence</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.patterns.map((row) => (
									<tr key={row.id}>
										<td>{row.patternKind}</td>
										<td>{row.patternKey}</td>
										<td>{row.status}</td>
										<td>{row.confidence.toFixed(2)}</td>
										<td>
											<details class="drawer">
												<summary>Open</summary>
												<JsonBlock value={row.summary} />
											</details>
										</td>
									</tr>
								))}
								{data.patterns.length === 0 ? (
									<tr>
										<td colspan={5}>No patterns staged.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
					<section class="card stack">
						<h2>Account mappings</h2>
						<table>
							<thead>
								<tr>
									<th>Mapping</th>
									<th>Book</th>
									<th>Debit</th>
									<th>Credit</th>
									<th>Confidence</th>
								</tr>
							</thead>
							<tbody>
								{data.accountMappings.map((row) => (
									<tr key={row.id}>
										<td>{row.mappingKey}</td>
										<td>{row.book}</td>
										<td>{row.debitAccount ?? "unmapped"}</td>
										<td>{row.creditAccount ?? "unmapped"}</td>
										<td>{row.confidence.toFixed(2)}</td>
									</tr>
								))}
								{data.accountMappings.length === 0 ? (
									<tr>
										<td colspan={5}>No account mappings cached.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
				</>
			) : null}

			{activeTab === "ledger" ? (
				<section class="card stack">
					<h2>Ledger</h2>
					<table>
						<thead>
							<tr>
								<th>Status</th>
								<th>When</th>
								<th>Description</th>
								<th>Amount</th>
								<th>Book</th>
								<th>Category</th>
								<th>Source</th>
								<th>Details</th>
							</tr>
						</thead>
						<tbody>
							{data.ledgerPreview.map((row) => (
								<tr key={row.canonicalKey}>
									<td>{row.status}</td>
									<td>{row.occurredAt ?? "unknown"}</td>
									<td>{row.description ?? "n/a"}</td>
									<td>
										{row.amountMinor != null ? money(row.amountMinor) : "n/a"}
									</td>
									<td>{row.book}</td>
									<td>
										{row.primaryCategory}
										{row.secondaryCategory ? ` / ${row.secondaryCategory}` : ""}
									</td>
									<td>{row.sourceKind}</td>
									<td>
										<details class="drawer">
											<summary>Open</summary>
											<JsonBlock value={row} />
										</details>
									</td>
								</tr>
							))}
							{data.ledgerPreview.length === 0 ? (
								<tr>
									<td colspan={8}>No ledger rows for current filters.</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</section>
			) : null}

			{activeTab === "imports" ? (
				<>
					<section class="card stack">
						<h2>Imported documents</h2>
						<table>
							<thead>
								<tr>
									<th>Type</th>
									<th>Issuer</th>
									<th>Period</th>
									<th>Tax year</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.importedDocuments.map((row) => (
									<tr key={row.id}>
										<td>{row.documentType}</td>
										<td>{row.issuer ?? "unknown"}</td>
										<td>
											{row.statementPeriodStart ?? "?"} to{" "}
											{row.statementPeriodEnd ?? "?"}
										</td>
										<td>{String(row.taxYear ?? "n/a")}</td>
										<td>
											<details class="drawer">
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.importedDocuments.length === 0 ? (
									<tr>
										<td colspan={5}>No imported documents.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
					<section class="card stack">
						<h2>Imported rows</h2>
						<table>
							<thead>
								<tr>
									<th>Source</th>
									<th>Posted</th>
									<th>Description</th>
									<th>Amount</th>
									<th>Mapping</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.importTransactions.map((row) => (
									<tr key={row.id}>
										<td>{row.sourceKind}</td>
										<td>{row.postedAt ?? row.occurredAt ?? "unknown"}</td>
										<td>{row.counterparty ?? row.description ?? "n/a"}</td>
										<td>
											{row.amountValue ?? "n/a"} {row.currency ?? ""}
										</td>
										<td>{row.accountMappingKey ?? "unmapped"}</td>
										<td>
											<details class="drawer">
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.importTransactions.length === 0 ? (
									<tr>
										<td colspan={6}>No imported rows.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
					<section class="card stack">
						<h2>Registry suggestions</h2>
						<table>
							<thead>
								<tr>
									<th>Kind</th>
									<th>Source</th>
									<th>Status</th>
									<th>Confidence</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.registrySuggestions.map((row) => (
									<tr key={row.id}>
										<td>{row.entityKind}</td>
										<td>{row.sourceKind}</td>
										<td>{row.status}</td>
										<td>{row.confidence.toFixed(2)}</td>
										<td>
											<details class="drawer">
												<summary>Open</summary>
												<JsonBlock value={row.suggestion} />
											</details>
										</td>
									</tr>
								))}
								{data.registrySuggestions.length === 0 ? (
									<tr>
										<td colspan={5}>No registry suggestions.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
				</>
			) : null}

			{activeTab === "exports" ? (
				<>
					<section class="card stack" data-page-actions="finance">
						<h2>Start export</h2>
						<form class="form-grid" data-rpc={appPath("/rpc/finance/export")}>
							<label>
								Year
								<input class="input" name="year" value={String(data.year)} />
							</label>
							<label>
								Output directory
								<input
									class="input"
									name="outDir"
									placeholder="operator default"
								/>
							</label>
							<label>
								Strict
								<input name="strict" type="checkbox" checked />
							</label>
							<div class="actions">
								<button class="button" type="submit">
									Queue export
								</button>
							</div>
						</form>
					</section>
					<section class="card stack">
						<h2>Export runs</h2>
						<table>
							<thead>
								<tr>
									<th>Status</th>
									<th>Year</th>
									<th>Items</th>
									<th>Output</th>
									<th>Validation</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.exportRuns.map((row) => (
									<tr key={row.id}>
										<td>{row.status}</td>
										<td>{String(row.year ?? "all")}</td>
										<td>{String(row.itemCount)}</td>
										<td>{row.outDir}</td>
										<td>
											{row.validation &&
											typeof row.validation === "object" &&
											"beanCheck" in row.validation
												? String(row.validation.beanCheck)
												: "pending"}
										</td>
										<td>
											<details class="drawer">
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.exportRuns.length === 0 ? (
									<tr>
										<td colspan={6}>No export runs.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
				</>
			) : null}

			{activeTab === "review" ? (
				<section class="card stack">
					<h2>Review queue</h2>
					<table>
						<thead>
							<tr>
								<th>Status</th>
								<th>When</th>
								<th>Description</th>
								<th>Amount</th>
								<th>Book</th>
								<th>Source</th>
								<th>Details</th>
							</tr>
						</thead>
						<tbody>
							{data.reviewRows.map((row) => (
								<tr key={row.canonicalKey}>
									<td>{row.status}</td>
									<td>{row.occurredAt ?? "unknown"}</td>
									<td>{row.description ?? "n/a"}</td>
									<td>
										{row.amountMinor != null ? money(row.amountMinor) : "n/a"}
									</td>
									<td>{row.book}</td>
									<td>{row.sourceKind}</td>
									<td>
										<details class="drawer">
											<summary>Open</summary>
											<JsonBlock value={row} />
										</details>
									</td>
								</tr>
							))}
							{data.reviewRows.length === 0 ? (
								<tr>
									<td colspan={7}>No unresolved ledger rows.</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</section>
			) : null}
		</>
	);
}

export function renderProfilePage(data: ProfilePageData) {
	return (
		<>
			<section class="card stack" data-page-actions="profiles">
				<div class="row">
					<h1>{data.account.label}</h1>
					<div class="actions">
						<Button
							label="Queue overseer rebuild"
							action={`/rpc/accounts/${data.account.id}/overseer/rebuild`}
						/>
						<a class="button secondary" href={href("/finance")}>
							Open finance
						</a>
					</div>
				</div>
				<p class="muted">{data.account.email_address}</p>
			</section>
			{data.profiles.length === 0 ? (
				<section class="card stack">
					<h2>No overseer profile yet</h2>
					<p class="muted">
						Queue a rebuild to generate the first profile for this account.
					</p>
				</section>
			) : (
				data.profiles.map((profile) => (
					<section key={profile.id} class="card stack">
						<div class="row">
							<Pill>{profile.created_at}</Pill>
							<Pill>{String(profile.built_from_messages)} messages</Pill>
						</div>
						<JsonBlock value={profile.profile} />
					</section>
				))
			)}
		</>
	);
}

function parseRunMeta(metaJson: string | null) {
	if (!metaJson) {
		return {} satisfies RunMeta;
	}
	const parsed: unknown = JSON.parse(metaJson);
	if (!parsed || typeof parsed !== "object") {
		return {} satisfies RunMeta;
	}
	const meta = parsed as Record<string, unknown>;
	return {
		processed: typeof meta.processed === "number" ? meta.processed : undefined,
		total: typeof meta.total === "number" ? meta.total : undefined,
		backendUsed:
			typeof meta.backendUsed === "string" ? meta.backendUsed : undefined,
		lastErrorMessage:
			typeof meta.lastErrorMessage === "string"
				? meta.lastErrorMessage
				: undefined,
	} satisfies RunMeta;
}

function formatEta(seconds: number | null | undefined) {
	if (seconds === 0) {
		return "done";
	}
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
		return "unknown";
	}
	const rounded = Math.max(0, Math.round(seconds));
	const days = Math.floor(rounded / 86400);
	const hours = Math.floor((rounded % 86400) / 3600);
	const minutes = Math.floor((rounded % 3600) / 60);
	const secs = rounded % 60;
	if (days > 0) {
		return `${String(days)}d ${String(hours)}h`;
	}
	if (hours > 0) {
		return `${String(hours)}h ${String(minutes)}m`;
	}
	return `${String(minutes)}m ${String(secs)}s`;
}

function formatProgress(
	processed: number | null | undefined,
	total: number | null | undefined,
) {
	if (processed === null || processed === undefined || !total) {
		return "n/a";
	}
	const percent = Math.min(100, Math.max(0, (processed / total) * 100));
	return `${String(processed)}/${String(total)} (${percent.toFixed(1)}%)`;
}

export function renderRunsPage(data: RunsPageData) {
	return (
		<>
			<section class="card stack">
				<h1>Runs</h1>
				<p class="muted">
					Raw worker jobs for live sync, backlog classification, and overseer
					rebuilds.
				</p>
				<div class="row">
					<Pill>preferred: {data.runtime.preferredBackend}</Pill>
					<Pill>resolved: {data.runtime.resolvedBackend ?? "unavailable"}</Pill>
				</div>
			</section>
			<section class="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Kind</th>
							<th>Status</th>
							<th>Scope</th>
							<th>Model</th>
							<th>Phase</th>
							<th>Progress</th>
							<th>ETA</th>
							<th>Updated</th>
							<th>Counts</th>
							<th>Live meta</th>
						</tr>
					</thead>
					<tbody>
						{data.jobs.map((row) => {
							const meta = parseRunMeta(row.meta_json);
							return (
								<tr key={row.id}>
									<td>{row.kind}</td>
									<td>{row.status}</td>
									<td>
										{row.scope_type}:{row.scope_id}
									</td>
									<td>{row.model ?? "n/a"}</td>
									<td>{row.progress.phase ?? "n/a"}</td>
									<td>
										{formatProgress(row.progress.processed, row.progress.total)}
									</td>
									<td>{formatEta(row.progress.etaSeconds)}</td>
									<td>{row.progress.updatedAt ?? "n/a"}</td>
									<td>
										{row.success_count}/{row.request_count} success,{" "}
										{row.error_count} errors
									</td>
									<td>
										<div class="stack">
											<span>
												processed: {String(meta.processed ?? 0)}/
												{String(meta.total ?? 0)}
											</span>
											<span>backend: {String(meta.backendUsed ?? "n/a")}</span>
											<span>
												last error:{" "}
												{row.last_error ??
													String(meta.lastErrorMessage ?? "none")}
											</span>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</section>
		</>
	);
}
