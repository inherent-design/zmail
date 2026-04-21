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
type LaneProgressSnapshot = HomePageData["laneProgress"][number];
type RunMeta = {
	processed?: number;
	total?: number;
	backendUsed?: string;
	lastErrorMessage?: string;
};

export type PageMode = "static" | "hybrid" | "dynamic-root";

export type IslandStatePolicy = {
	semanticUrlKeys: string[];
	sessionKeys: string[];
	ephemeralKeys: string[];
	restoreOnSwap: boolean;
	shareable: "none" | "committed" | "live";
};

export type IslandDefinition = {
	id: string;
	page: string;
	mode: "server" | "client" | "dynamic-root";
	fragmentUrl: string;
	topics: string[];
	statePolicy: IslandStatePolicy;
	fallback: "none" | "main";
};

export type IslandRenderMap = Record<string, unknown>;

const DEFAULT_STATE_POLICY = {
	semanticUrlKeys: [],
	sessionKeys: ["scroll", "details"],
	ephemeralKeys: ["hover", "brush", "crosshair", "pendingRpc"],
	restoreOnSwap: true,
	shareable: "none",
} satisfies IslandStatePolicy;

const FORM_STATE_POLICY = {
	semanticUrlKeys: [],
	sessionKeys: ["focus", "formValues", "selection", "scroll", "details"],
	ephemeralKeys: ["hover", "pendingRpc"],
	restoreOnSwap: true,
	shareable: "none",
} satisfies IslandStatePolicy;

const CHART_STATE_POLICY = {
	semanticUrlKeys: [
		"year",
		"accountId",
		"institutionId",
		"ownerIdentityId",
		"sourceKind",
	],
	sessionKeys: ["chartZoom", "hiddenSeries", "scroll", "details"],
	ephemeralKeys: ["hover", "brush", "crosshair", "pendingRpc"],
	restoreOnSwap: true,
	shareable: "committed",
} satisfies IslandStatePolicy;

const FINANCE_TAB_STATE_POLICY = {
	semanticUrlKeys: [
		"tab",
		"year",
		"accountId",
		"institutionId",
		"ownerIdentityId",
		"sourceKind",
		"status",
		"book",
		"category",
		"mappingState",
		"drilldown",
	],
	sessionKeys: ["tableSort", "expandedRow", "selectedRow", "scroll", "details"],
	ephemeralKeys: ["hover", "pendingRpc"],
	restoreOnSwap: true,
	shareable: "committed",
} satisfies IslandStatePolicy;

const island = (
	definition: Omit<IslandDefinition, "mode" | "statePolicy" | "fallback"> & {
		mode?: IslandDefinition["mode"];
		statePolicy?: IslandStatePolicy;
		fallback?: IslandDefinition["fallback"];
	},
) =>
	({
		...definition,
		mode: definition.mode ?? "server",
		statePolicy: definition.statePolicy ?? DEFAULT_STATE_POLICY,
		fallback: definition.fallback ?? "none",
	}) satisfies IslandDefinition;

export const ISLAND_DEFINITIONS = {
	"home.hero": island({
		id: "home.hero",
		page: "home",
		fragmentUrl: "/",
		topics: [],
	}),
	"home.stats": island({
		id: "home.stats",
		page: "home",
		fragmentUrl: "/",
		topics: ["accounts", "jobs", "reviews"],
	}),
	"home.lanes": island({
		id: "home.lanes",
		page: "home",
		fragmentUrl: "/",
		topics: ["jobs"],
	}),
	"home.actions": island({
		id: "home.actions",
		page: "home",
		fragmentUrl: "/",
		topics: [],
	}),
	"accounts.summary": island({
		id: "accounts.summary",
		page: "accounts",
		fragmentUrl: "/accounts",
		topics: ["accounts", "jobs"],
	}),
	"accounts.list": island({
		id: "accounts.list",
		page: "accounts",
		fragmentUrl: "/accounts",
		topics: ["accounts", "jobs"],
		statePolicy: FORM_STATE_POLICY,
	}),
	"accounts.actions": island({
		id: "accounts.actions",
		page: "accounts",
		fragmentUrl: "/accounts",
		topics: [],
	}),
	"account.header": island({
		id: "account.header",
		page: "account-detail",
		fragmentUrl: "/accounts/:accountId",
		topics: ["account:{accountId}"],
	}),
	"account.actions": island({
		id: "account.actions",
		page: "account-detail",
		fragmentUrl: "/accounts/:accountId",
		topics: ["account:{accountId}"],
	}),
	"account.mailbox-sync": island({
		id: "account.mailbox-sync",
		page: "account-detail",
		fragmentUrl: "/accounts/:accountId",
		topics: ["account:{accountId}"],
	}),
	"account.lanes": island({
		id: "account.lanes",
		page: "account-detail",
		fragmentUrl: "/accounts/:accountId",
		topics: ["account:{accountId}"],
	}),
	"account.stats": island({
		id: "account.stats",
		page: "account-detail",
		fragmentUrl: "/accounts/:accountId",
		topics: ["account:{accountId}"],
	}),
	"account.recent-jobs": island({
		id: "account.recent-jobs",
		page: "account-detail",
		fragmentUrl: "/accounts/:accountId",
		topics: ["account:{accountId}"],
	}),
	"message.header": island({
		id: "message.header",
		page: "message-detail",
		fragmentUrl: "/messages/:messageId",
		topics: ["message:{messageId}", "reviews"],
	}),
	"message.body": island({
		id: "message.body",
		page: "message-detail",
		fragmentUrl: "/messages/:messageId",
		topics: ["message:{messageId}"],
		statePolicy: FORM_STATE_POLICY,
	}),
	"message.labels": island({
		id: "message.labels",
		page: "message-detail",
		fragmentUrl: "/messages/:messageId",
		topics: ["message:{messageId}", "reviews"],
	}),
	"message.finance": island({
		id: "message.finance",
		page: "message-detail",
		fragmentUrl: "/messages/:messageId",
		topics: ["message:{messageId}", "finance"],
	}),
	"message.reviews": island({
		id: "message.reviews",
		page: "message-detail",
		fragmentUrl: "/messages/:messageId",
		topics: ["message:{messageId}", "reviews"],
	}),
	"message.actions": island({
		id: "message.actions",
		page: "message-detail",
		fragmentUrl: "/messages/:messageId",
		topics: ["message:{messageId}", "reviews"],
	}),
	"review.queue": island({
		id: "review.queue",
		page: "review",
		fragmentUrl: "/review",
		topics: ["reviews"],
		statePolicy: FORM_STATE_POLICY,
	}),
	"review.stats": island({
		id: "review.stats",
		page: "review",
		fragmentUrl: "/review",
		topics: ["reviews"],
	}),
	"review.actions": island({
		id: "review.actions",
		page: "review",
		fragmentUrl: "/review",
		topics: ["reviews"],
	}),
	"finance.command-bar": island({
		id: "finance.command-bar",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.filters": island({
		id: "finance.filters",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.lanes": island({
		id: "finance.lanes",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["jobs"],
	}),
	"finance.summary": island({
		id: "finance.summary",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.cashflow": island({
		id: "finance.cashflow",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance"],
		statePolicy: CHART_STATE_POLICY,
	}),
	"finance.categories": island({
		id: "finance.categories",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance"],
		statePolicy: CHART_STATE_POLICY,
	}),
	"finance.subscriptions": island({
		id: "finance.subscriptions",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.overview.rollups": island({
		id: "finance.overview.rollups",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.readiness": island({
		id: "finance.readiness",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs", "reviews"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.ledger": island({
		id: "finance.ledger",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.imports": island({
		id: "finance.imports",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.mappings": island({
		id: "finance.mappings",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FORM_STATE_POLICY,
	}),
	"finance.review": island({
		id: "finance.review",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "reviews", "jobs"],
		statePolicy: FINANCE_TAB_STATE_POLICY,
	}),
	"finance.tax": island({
		id: "finance.tax",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FORM_STATE_POLICY,
	}),
	"finance.export-health": island({
		id: "finance.export-health",
		page: "finance",
		fragmentUrl: "/finance",
		topics: ["finance", "jobs"],
		statePolicy: FORM_STATE_POLICY,
	}),
	"profiles.header": island({
		id: "profiles.header",
		page: "profiles",
		fragmentUrl: "/profiles/:accountId",
		topics: ["account:{accountId}", "finance", "jobs"],
	}),
	"profiles.summary": island({
		id: "profiles.summary",
		page: "profiles",
		fragmentUrl: "/profiles/:accountId",
		topics: ["account:{accountId}", "finance", "jobs"],
	}),
	"profiles.findings": island({
		id: "profiles.findings",
		page: "profiles",
		fragmentUrl: "/profiles/:accountId",
		topics: ["account:{accountId}", "finance", "jobs"],
		statePolicy: DEFAULT_STATE_POLICY,
	}),
	"profiles.actions": island({
		id: "profiles.actions",
		page: "profiles",
		fragmentUrl: "/profiles/:accountId",
		topics: ["account:{accountId}", "finance", "jobs"],
	}),
	"runs.lanes": island({
		id: "runs.lanes",
		page: "runs",
		fragmentUrl: "/runs",
		topics: ["jobs"],
	}),
	"runs.jobs": island({
		id: "runs.jobs",
		page: "runs",
		fragmentUrl: "/runs",
		topics: ["jobs"],
		statePolicy: DEFAULT_STATE_POLICY,
	}),
} satisfies Record<string, IslandDefinition>;

function islandDefinition(id: string) {
	const definition = (ISLAND_DEFINITIONS as Record<string, IslandDefinition>)[
		id
	];
	if (!definition) {
		throw new Error(`Missing island definition for ${id}`);
	}
	return definition;
}

function json(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function jsonScript(value: unknown) {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

function href(path: string) {
	return appPath(path);
}

export function DocumentShell(input: {
	title: string;
	page: string;
	eventCursor: number;
	stateScope: string;
	children: unknown;
}) {
	return (
		<html
			lang="en"
			data-page={input.page}
			data-zmail-base-path={CLIENT_CONFIG.server.basePath}
			data-zmail-event-cursor={String(input.eventCursor)}
			data-zmail-state-scope={input.stateScope}
		>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{input.title}</title>
				<link rel="stylesheet" href={assetPath("/assets/styles.css")} />
				<script
					type="importmap"
					dangerouslySetInnerHTML={{
						__html: jsonScript({
							imports: {
								"echarts/": assetPath("/vendor/echarts/"),
								tslib: assetPath("/vendor/tslib/tslib.es6.js"),
								"zrender/": assetPath("/vendor/zrender/"),
							},
						}),
					}}
				/>
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
				<script type="module" src={assetPath("/client/core/browser-env.js")} />
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

export function IslandFrame(input: {
	id: string;
	mode?: "server" | "client" | "dynamic-root";
	class?: string;
	children: unknown;
}) {
	const definition = islandDefinition(input.id);
	return (
		<section
			class={input.class ?? "card stack"}
			data-zmail-island={input.id}
			data-zmail-island-mode={input.mode ?? definition.mode}
			data-zmail-state-policy={jsonScript(definition.statePolicy)}
			data-zmail-refresh-topics={
				definition.topics.length ? definition.topics.join(",") : undefined
			}
		>
			{input.children}
		</section>
	);
}

export function IslandPropsScript(input: { id: string; props: unknown }) {
	return (
		<script
			type="application/json"
			data-zmail-island-props={input.id}
			dangerouslySetInnerHTML={{ __html: jsonScript(input.props) }}
		/>
	);
}

export function IslandFragmentEnvelope(input: {
	page: string;
	eventCursor: number;
	children: unknown;
}) {
	return (
		<div
			data-zmail-island-fragments={input.page}
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

function mailboxStateLabel(
	syncStatus: string,
	syncState?: { backfill_next_uid?: number | null } | null,
) {
	if (syncStatus === "backfilling" || syncState?.backfill_next_uid != null) {
		return "backfill pending";
	}
	return syncStatus;
}

function renderLaneProgressCards(lanes: LaneProgressSnapshot[]) {
	return (
		<div class="stats compact lane-grid">
			{lanes.map((lane) => (
				<div key={lane.lane} class={`stat lane-card lane-${lane.state}`}>
					<span class="muted">{lane.label}</span>
					<strong>{lane.state}</strong>
					<div class="stack">
						<span>
							queued/running: {String(lane.queuedCount)}/
							{String(lane.runningCount)}
						</span>
						<span>kind: {lane.runningKind ?? "n/a"}</span>
						<span>progress: {formatProgress(lane.processed, lane.total)}</span>
						<span>ETA: {formatEta(lane.etaSeconds)}</span>
						{lane.lastError ? <span>error: {lane.lastError}</span> : null}
					</div>
				</div>
			))}
		</div>
	);
}

function activeLanes(lanes: LaneProgressSnapshot[]) {
	return lanes.filter(
		(lane) => lane.state === "running" || lane.state === "queued",
	);
}

function renderAccountWorkStatus(lanes: LaneProgressSnapshot[]) {
	const active = activeLanes(lanes);
	if (active.length === 0) {
		return <span class="muted">idle</span>;
	}
	return (
		<div class="stack account-work">
			{active.map((lane) => (
				<span key={lane.lane}>
					{lane.label}: {lane.state} ({String(lane.queuedCount)}/
					{String(lane.runningCount)}) |{" "}
					{formatProgress(lane.processed, lane.total)} | ETA{" "}
					{formatEta(lane.etaSeconds)}
				</span>
			))}
		</div>
	);
}

export function renderHomeIslandMap(data: HomePageData) {
	return {
		"home.hero": (
			<IslandFrame id="home.hero" class="card stack">
				<h1>zmail</h1>
				<p class="muted">Gmail live-sync analysis workspace.</p>
			</IslandFrame>
		),
		"home.stats": (
			<IslandFrame id="home.stats" class="stats">
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
			</IslandFrame>
		),
		"home.lanes": (
			<IslandFrame id="home.lanes" class="card stack">
				<h2>Lane state</h2>
				{renderLaneProgressCards(data.laneProgress)}
			</IslandFrame>
		),
		"home.actions": (
			<IslandFrame id="home.actions" class="card stack">
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
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const HOME_ISLAND_IDS = [
	"home.hero",
	"home.stats",
	"home.lanes",
	"home.actions",
] as const;

export function renderHomePage(data: HomePageData) {
	const islands = renderHomeIslandMap(data);
	return <>{HOME_ISLAND_IDS.map((id) => islands[id])}</>;
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
	const islands = renderAccountsIslandMap(data, options);
	return <>{ACCOUNTS_ISLAND_IDS.map((id) => islands[id])}</>;
}

export function renderAccountsIslandMap(
	data: AccountsPageData,
	options?: {
		canConnect?: boolean;
		canManageLifecycle?: (ownerPrincipalEmail: string | null) => boolean;
	},
) {
	const connectedCount = data.accounts.filter(
		(account) => account.connection_state === "connected",
	).length;
	const syncEnabledCount = data.accounts.filter(
		(account) => account.sync_enabled,
	).length;
	const attentionCount = data.accounts.filter(
		(account) =>
			account.connection_state === "config_error" ||
			account.connection_state === "needs_reconnect" ||
			account.connection_state === "disconnected" ||
			Boolean(account.last_error),
	).length;
	const activeWorkCount = data.accounts.filter(
		(account) => activeLanes(account.lane_progress).length > 0,
	).length;
	return {
		"accounts.summary": (
			<IslandFrame id="accounts.summary" class="card stack">
				<div class="row">
					<h1>Accounts</h1>
					{options?.canConnect === false ? null : (
						<a class="button" href={href("/accounts/new")}>
							Connect Gmail
						</a>
					)}
				</div>
				<p class="muted">Connected email accounts and their sync status.</p>
				<div class="stats compact">
					<div class="stat">
						<span class="muted">Accounts</span>
						<strong>{String(data.accounts.length)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Connected</span>
						<strong>{String(connectedCount)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Sync enabled</span>
						<strong>{String(syncEnabledCount)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Needs attention</span>
						<strong>{String(attentionCount)}</strong>
					</div>
					<div class="stat">
						<span class="muted">Active work</span>
						<strong>{String(activeWorkCount)}</strong>
					</div>
				</div>
			</IslandFrame>
		),
		"accounts.list": (
			<IslandFrame id="accounts.list" class="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Label</th>
							<th>Email</th>
							<th>Provider</th>
							<th>Connection</th>
							<th>Sync</th>
							<th>Mailbox</th>
							<th>Work</th>
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
									<td>{mailboxStateLabel(account.sync_status)}</td>
									<td>{renderAccountWorkStatus(account.lane_progress)}</td>
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
			</IslandFrame>
		),
		"accounts.actions": (
			<IslandFrame id="accounts.actions" class="card stack">
				<h2>Account actions</h2>
				<div class="actions">
					{options?.canConnect === false ? null : (
						<a class="button" href={href("/accounts/new")}>
							Connect Gmail
						</a>
					)}
					<a class="button secondary" href={href("/messages")}>
						Browse messages
					</a>
					<a class="button secondary" href={href("/runs")}>
						Open runs
					</a>
				</div>
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const ACCOUNTS_ISLAND_IDS = [
	"accounts.summary",
	"accounts.list",
	"accounts.actions",
] as const;

export function renderAccountDetailIslandMap(
	data: AccountDetailPageData,
	options: {
		canManageLifecycle: boolean;
		canOperate: boolean;
	},
) {
	const account = data.account;
	const accountId = account.id;
	return {
		"account.header": (
			<IslandFrame id="account.header" class="card stack">
				<h1>{account.label}</h1>
				<p class="muted">{account.email_address}</p>
				<div class="row">
					<Pill>{account.provider_kind}</Pill>
					<Pill>
						connection: {prettyConnectionState(data.connection_state)}
					</Pill>
					<Pill>sync: {account.sync_enabled ? "enabled" : "disabled"}</Pill>
					<Pill>
						mailbox: {mailboxStateLabel(account.sync_status, data.syncState)}
					</Pill>
					<Pill>token: {data.has_oauth_token ? "present" : "missing"}</Pill>
				</div>
				{account.last_error ? (
					<p class="muted">Last error: {account.last_error}</p>
				) : null}
			</IslandFrame>
		),
		"account.actions": (
			<IslandFrame id="account.actions" class="card stack">
				<h2>Account actions</h2>
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
			</IslandFrame>
		),
		"account.mailbox-sync": (
			<IslandFrame id="account.mailbox-sync" class="card stack">
				<h2>Mailbox sync</h2>
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
						<span class="muted">Historical UID remaining</span>
						<strong>{String(data.syncProgress.remaining ?? "n/a")}</strong>
					</div>
				</div>
				<div class="row">
					<Pill>raw sync_status: {data.syncProgress.status}</Pill>
					<Pill>
						watcher: {data.syncState?.watcher_status ?? "not_initialized"}
					</Pill>
					<Pill>updated: {data.syncProgress.updatedAt ?? "n/a"}</Pill>
				</div>
			</IslandFrame>
		),
		"account.lanes": (
			<IslandFrame id="account.lanes" class="card stack">
				<h2>Lane state</h2>
				{renderLaneProgressCards(data.laneProgress)}
			</IslandFrame>
		),
		"account.stats": (
			<IslandFrame id="account.stats" class="card stack">
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
			</IslandFrame>
		),
		"account.recent-jobs": (
			<IslandFrame id="account.recent-jobs" class="card stack">
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
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const ACCOUNT_DETAIL_ISLAND_IDS = [
	"account.header",
	"account.actions",
	"account.mailbox-sync",
	"account.lanes",
	"account.stats",
	"account.recent-jobs",
] as const;

function renderAccountDangerZone(
	data: AccountDetailPageData,
	options: {
		canManageLifecycle: boolean;
	},
) {
	const accountId = data.account.id;
	return (
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
	);
}

export function renderAccountDetailPage(
	data: AccountDetailPageData,
	options: {
		canManageLifecycle: boolean;
		canOperate: boolean;
	},
) {
	const islands = renderAccountDetailIslandMap(data, options);
	return (
		<>
			{ACCOUNT_DETAIL_ISLAND_IDS.map((id) => islands[id])}
			{renderAccountDangerZone(data, options)}
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

export function renderMessageDetailIslandMap(data: MessageDetailPageData) {
	return {
		"message.header": (
			<IslandFrame id="message.header" class="card stack">
				<div class="row">
					<h1>{data.message.subject ?? "(no subject)"}</h1>
				</div>
				<div class="row muted">
					<span>{data.message.account_label}</span>
					<span>{data.message.received_at ?? "unknown date"}</span>
					<span>{data.message.sender_address ?? "unknown sender"}</span>
				</div>
			</IslandFrame>
		),
		"message.actions": (
			<IslandFrame id="message.actions" class="card stack">
				<div class="actions" data-page-actions="message-detail">
					<Button
						label="Classify now"
						action={`/rpc/messages/${data.message.id}/classify`}
					/>
				</div>
			</IslandFrame>
		),
		"message.body": (
			<IslandFrame id="message.body" class="card stack">
				<h2>Message body</h2>
				<div class="stack">
					<div class="stack">
						<h3>Primary body</h3>
						<pre class="json-block">
							{data.message.body_text_primary || "(empty)"}
						</pre>
					</div>
					{data.message.body_text_forwarded ? (
						<div class="stack">
							<h3>Forwarded body</h3>
							<pre class="json-block">{data.message.body_text_forwarded}</pre>
						</div>
					) : null}
					<div class="stack">
						<h3>Classifier/search body</h3>
						<pre class="json-block">
							{data.message.body_text_normalized || "(empty)"}
						</pre>
					</div>
				</div>
			</IslandFrame>
		),
		"message.labels": (
			<IslandFrame id="message.labels" class="card stack">
				<h2>Labels and classifications</h2>
				<div class="stack">
					<div>
						<h3>Current label</h3>
						<JsonBlock value={data.currentLabel?.label ?? null} />
					</div>
					<div>
						<h3>Classification history</h3>
						<JsonBlock value={data.classifications} />
					</div>
				</div>
			</IslandFrame>
		),
		"message.finance": (
			<IslandFrame id="message.finance" class="card stack">
				<h2>Finance intel</h2>
				<JsonBlock value={data.financeIntel} />
			</IslandFrame>
		),
		"message.reviews": (
			<IslandFrame id="message.reviews" class="card stack">
				<h2>Related context</h2>
				<div class="stack">
					<details class="drawer">
						<summary>Metadata</summary>
						<JsonBlock value={data.message} />
					</details>
					<details class="drawer">
						<summary>Attachments</summary>
						<JsonBlock value={data.attachments} />
					</details>
					<details class="drawer">
						<summary>Moderation</summary>
						<JsonBlock value={data.moderation} />
					</details>
					<details class="drawer">
						<summary>Latest overseer profile</summary>
						<JsonBlock value={data.latestProfile} />
					</details>
				</div>
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const MESSAGE_DETAIL_ISLAND_IDS = [
	"message.header",
	"message.actions",
	"message.body",
	"message.labels",
	"message.finance",
	"message.reviews",
] as const;

export function renderMessageDetailPage(data: MessageDetailPageData) {
	const islands = renderMessageDetailIslandMap(data);
	return (
		<>
			{islands["message.header"]}
			{islands["message.actions"]}
			<section class="two-up">
				<div class="stack">
					{islands["message.body"]}
					{islands["message.labels"]}
					{islands["message.finance"]}
				</div>
				<div class="stack">{islands["message.reviews"]}</div>
			</section>
		</>
	);
}

export function renderReviewIslandMap(rows: ReviewPageData) {
	return {
		"review.stats": (
			<IslandFrame id="review.stats" class="card stack">
				<div class="row">
					<div>
						<h1>Review</h1>
						<p class="muted">Root decisions, classifier findings, actions.</p>
					</div>
					<div class="stats compact">
						<div class="stat">
							<span class="muted">Open root reviews</span>
							<strong>{String(rows.rootReviews.length)}</strong>
						</div>
						<div class="stat">
							<span class="muted">Classifier findings</span>
							<strong>{String(rows.findings.length)}</strong>
						</div>
						<div class="stat">
							<span class="muted">Classifier runs</span>
							<strong>{String(rows.actionHistory.length)}</strong>
						</div>
					</div>
				</div>
				<h2>Review classifier findings</h2>
				<table>
					<thead>
						<tr>
							<th>Target</th>
							<th>Severity</th>
							<th>Action</th>
							<th>Confidence</th>
							<th>Reason</th>
						</tr>
					</thead>
					<tbody>
						{rows.findings.map((row) => (
							<tr key={`${row.target_kind}:${row.target_id}`}>
								<td>
									{row.target_kind}:{row.target_id}
								</td>
								<td>{row.severity}</td>
								<td>{row.action}</td>
								<td>{percent(row.confidence)}</td>
								<td>{row.reason}</td>
							</tr>
						))}
						{rows.findings.length === 0 ? (
							<tr>
								<td colspan={5}>No review classifier findings.</td>
							</tr>
						) : null}
					</tbody>
				</table>
				<h2>Action history</h2>
				<table>
					<thead>
						<tr>
							<th>Created</th>
							<th>Model</th>
							<th>Findings</th>
							<th>Details</th>
						</tr>
					</thead>
					<tbody>
						{rows.actionHistory.map((row) => (
							<tr key={row.id}>
								<td>{row.createdAt}</td>
								<td>{row.model}</td>
								<td>
									{typeof row.result === "object" &&
									row.result !== null &&
									"findings" in row.result &&
									Array.isArray((row.result as { findings?: unknown }).findings)
										? String(
												(row.result as { findings: unknown[] }).findings.length,
											)
										: "0"}
								</td>
								<td>
									<details class="drawer">
										<summary>Open</summary>
										<JsonBlock value={row.result} />
									</details>
								</td>
							</tr>
						))}
						{rows.actionHistory.length === 0 ? (
							<tr>
								<td colspan={4}>No review classifier runs.</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</IslandFrame>
		),
		"review.actions": (
			<IslandFrame id="review.actions" class="card stack">
				<h2>Review actions</h2>
				<div class="actions" data-page-actions="review-global">
					<Button label="Classify reviews" action="/rpc/reviews/classify" />
				</div>
			</IslandFrame>
		),
		"review.queue": (
			<IslandFrame id="review.queue" class="stack">
				{rows.rootReviews.map((row) => (
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
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const REVIEW_ISLAND_IDS = [
	"review.stats",
	"review.actions",
	"review.queue",
] as const;

export function renderReviewPage(rows: ReviewPageData) {
	const islands = renderReviewIslandMap(rows);
	return <>{REVIEW_ISLAND_IDS.map((id) => islands[id])}</>;
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

export const FINANCE_ISLAND_IDS = [
	"finance.command-bar",
	"finance.filters",
	"finance.lanes",
	"finance.summary",
	"finance.cashflow",
	"finance.categories",
	"finance.subscriptions",
	"finance.overview.rollups",
	"finance.readiness",
	"finance.ledger",
	"finance.imports",
	"finance.mappings",
	"finance.review",
	"finance.tax",
	"finance.export-health",
] as const;

function financePageContext(
	data: FinancePageData,
	currentSearch: URLSearchParams,
) {
	const tabKeys = [
		"overview",
		"readiness",
		"ledger",
		"imports",
		"mappings",
		"exports",
		"tax",
		"review",
	];
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
	return { tabKeys, activeTab, tabHref, warnings };
}

function percent(value: number) {
	return `${Math.round(value * 100)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readinessBlockerCount(manifest: unknown) {
	if (!isRecord(manifest) || !isRecord(manifest.readiness)) {
		return 0;
	}
	const blockers = manifest.readiness.blockers;
	return Array.isArray(blockers) ? blockers.length : 0;
}

function taxRunStatusLabel(status: string) {
	return status === "audit_only" ? "audit snapshot" : status;
}

function financeActiveTabIslandId(activeTab: string) {
	switch (activeTab) {
		case "readiness":
			return "finance.readiness";
		case "ledger":
			return "finance.ledger";
		case "imports":
			return "finance.imports";
		case "mappings":
			return "finance.mappings";
		case "review":
			return "finance.review";
		case "tax":
			return "finance.tax";
		case "exports":
			return "finance.export-health";
		default:
			return "finance.overview.rollups";
	}
}

export function renderFinanceIslandMap(
	data: FinancePageData,
	currentSearch: URLSearchParams,
) {
	const { tabKeys, activeTab, tabHref, warnings } = financePageContext(
		data,
		currentSearch,
	);
	const mappingSuggestions = data.registrySuggestions.filter((row) => {
		const suggestion = row.suggestion as unknown;
		return (
			row.entityKind === "finance_account_mapping" &&
			isRecord(suggestion) &&
			suggestion.schemaVersion === "finance-account-mapping-suggestion.v1"
		);
	});

	return {
		"finance.command-bar": (
			<IslandFrame id="finance.command-bar" class="card stack finance-command">
				<div class="row">
					<div>
						<h1>Finance instrument panel</h1>
						<p class="muted">Ledger staging, cashflow, recurring charges.</p>
					</div>
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
							label="Generate mappings"
							action="/rpc/finance/mappings/generate"
							payload={{ year: data.year }}
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
						<Button
							label="Classify reviews"
							action="/rpc/reviews/classify"
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
					<div class="warning-strip">
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
			</IslandFrame>
		),
		"finance.filters": (
			<IslandFrame id="finance.filters" class="card stack finance-filters">
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
			</IslandFrame>
		),
		"finance.lanes": (
			<IslandFrame id="finance.lanes" class="card stack">
				<h2>Lane state</h2>
				{renderLaneProgressCards(data.laneProgress)}
			</IslandFrame>
		),
		"finance.summary": (
			<IslandFrame id="finance.summary" class="stats finance-kpis">
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
			</IslandFrame>
		),
		"finance.cashflow": (
			<IslandFrame id="finance.cashflow" class="card stack chart-card">
				<div class="row">
					<div>
						<h2>Cashflow</h2>
						<p class="muted">Monthly inflow, outflow, and net movement.</p>
					</div>
				</div>
				<div
					class="chart-frame"
					data-finance-chart="cashflow"
					role="img"
					aria-label="Monthly finance cashflow chart"
				/>
				<IslandPropsScript
					id="finance.cashflow"
					props={{
						year: data.year,
						series: data.cashflowSeries,
					}}
				/>
			</IslandFrame>
		),
		"finance.categories": (
			<IslandFrame id="finance.categories" class="card stack chart-card">
				<div class="row">
					<div>
						<h2>Category breakdown</h2>
						<p class="muted">Outflow-first category pressure.</p>
					</div>
				</div>
				<div
					class="chart-frame"
					data-finance-chart="categories"
					role="img"
					aria-label="Finance category breakdown chart"
				/>
				<IslandPropsScript
					id="finance.categories"
					props={{
						categories: data.categoryBreakdown.slice(0, 12),
					}}
				/>
				<table>
					<thead>
						<tr>
							<th>Category</th>
							<th>Outflow</th>
							<th>Inflow</th>
							<th>Net</th>
							<th>Count</th>
						</tr>
					</thead>
					<tbody>
						{data.categoryBreakdown.slice(0, 8).map((row) => (
							<tr key={`${row.primaryCategory}:${row.secondaryCategory ?? ""}`}>
								<td>
									{row.primaryCategory}
									{row.secondaryCategory ? ` / ${row.secondaryCategory}` : ""}
								</td>
								<td>{money(row.outflowMinor)}</td>
								<td>{money(row.inflowMinor)}</td>
								<td>{money(row.netMinor)}</td>
								<td>{String(row.transactionCount)}</td>
							</tr>
						))}
						{data.categoryBreakdown.length === 0 ? (
							<tr>
								<td colspan={5}>No category data for current filters.</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</IslandFrame>
		),
		"finance.subscriptions": (
			<IslandFrame id="finance.subscriptions" class="card stack">
				<div class="row">
					<div>
						<h2>Recurring charges</h2>
						<p class="muted">Subscription lens from materialized patterns.</p>
					</div>
					<Pill>{String(data.subscriptionPatterns.length)} patterns</Pill>
				</div>
				<table>
					<thead>
						<tr>
							<th>Counterparty</th>
							<th>Book</th>
							<th>Count</th>
							<th>Confidence</th>
							<th>Last seen</th>
							<th>Details</th>
						</tr>
					</thead>
					<tbody>
						{data.subscriptionPatterns.map((row) => (
							<tr key={row.id}>
								<td>{row.counterparty}</td>
								<td>{row.book ?? "unknown"}</td>
								<td>{String(row.transactionCount)}</td>
								<td>{percent(row.confidence)}</td>
								<td>{row.lastSeenAt ?? "unknown"}</td>
								<td>
									<details class="drawer">
										<summary>Open</summary>
										<JsonBlock value={row.summary} />
									</details>
								</td>
							</tr>
						))}
						{data.subscriptionPatterns.length === 0 ? (
							<tr>
								<td colspan={6}>
									No recurring patterns yet. Rebuild finance knowledge after
									finance classification catches up.
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</IslandFrame>
		),
		[financeActiveTabIslandId(activeTab)]: (
			<IslandFrame id={financeActiveTabIslandId(activeTab)} class="card stack">
				{activeTab === "overview" ? (
					<>
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
					</>
				) : null}

				{activeTab === "readiness" ? (
					<>
						<h2>Readiness workbench</h2>
						<div class="stats compact">
							<div class="stat">
								<span class="muted">Ready</span>
								<strong>{String(data.readiness.statusCounts.ready)}</strong>
							</div>
							<div class="stat">
								<span class="muted">Review</span>
								<strong>{String(data.readiness.statusCounts.review)}</strong>
							</div>
							<div class="stat">
								<span class="muted">Blocked</span>
								<strong>{String(data.readiness.statusCounts.blocked)}</strong>
							</div>
							<div class="stat">
								<span class="muted">Mappings</span>
								<strong>
									{String(data.readiness.mappingCoverage.mappedRows)}/
									{String(data.readiness.mappingCoverage.totalRows)}
								</strong>
							</div>
						</div>
						<table>
							<thead>
								<tr>
									<th>Gap</th>
									<th>Rows</th>
								</tr>
							</thead>
							<tbody>
								{Object.entries(data.readiness.missing).map(([name, count]) => (
									<tr key={name}>
										<td>{name}</td>
										<td>{String(count)}</td>
									</tr>
								))}
							</tbody>
						</table>
						<h2>Open finance jobs</h2>
						<table>
							<thead>
								<tr>
									<th>Kind</th>
									<th>Queued</th>
									<th>Running</th>
								</tr>
							</thead>
							<tbody>
								{data.readiness.openJobsThatMayChangeTotals.map((row) => (
									<tr key={row.kind}>
										<td>{row.kind}</td>
										<td>{String(row.queued)}</td>
										<td>{String(row.running)}</td>
									</tr>
								))}
								{data.readiness.openJobsThatMayChangeTotals.length === 0 ? (
									<tr>
										<td colspan={3}>No open finance jobs.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</>
				) : null}

				{activeTab === "ledger" ? (
					<>
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
											{row.secondaryCategory
												? ` / ${row.secondaryCategory}`
												: ""}
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
					</>
				) : null}

				{activeTab === "imports" ? (
					<>
						<h2>Upload transactions</h2>
						<form
							class="form-grid"
							enctype="multipart/form-data"
							method="post"
							action={href("/api/finance/uploads")}
							data-finance-upload="true"
						>
							<label>
								File
								<input
									type="file"
									name="file"
									accept="application/pdf,application/zip,.pdf,.zip"
									required
								/>
							</label>
							<label>
								Mode
								<select name="mode">
									<option value="auto" selected>
										Auto
									</option>
									<option value="direct_llm">Direct LLM</option>
									<option value="voyage_gate">Voyage gate</option>
								</select>
							</label>
							<label>
								Source
								<select name="sourceKindHint">
									<option value="">PDF</option>
									<option value="statement">Statement</option>
								</select>
							</label>
							<div class="actions">
								<button type="submit">Upload</button>
							</div>
						</form>
						<h2>Upload runs</h2>
						<table>
							<thead>
								<tr>
									<th>File</th>
									<th>Status</th>
									<th>Files</th>
									<th>Selected pages</th>
									<th>Mode</th>
									<th>Bytes</th>
									<th>Artifact/import</th>
									<th>Updated</th>
									<th>Error</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.uploadRuns.map((row) => (
									<tr key={row.id}>
										<td>{row.originalFilename}</td>
										<td>{row.status}</td>
										<td>{String(row.fileCount)}</td>
										<td>{String(row.selectedPageCount)}</td>
										<td>{row.mode}</td>
										<td>{String(row.totalBytes)}</td>
										<td>
											{row.artifactSha256?.slice(0, 12) ?? "n/a"}
											{row.importRunId
												? ` / ${row.importRunId.slice(0, 8)}`
												: ""}
										</td>
										<td>{row.updatedAt}</td>
										<td>
											{row.status === "failed" || row.status === "needs_review"
												? String(row.error?.reason ?? row.error?.message ?? "")
												: ""}
										</td>
										<td>
											<details
												class="drawer"
												data-zmail-state-key={`finance-upload:${row.id}`}
											>
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.uploadRuns.length === 0 ? (
									<tr>
										<td colspan={10}>No upload runs.</td>
									</tr>
								) : null}
							</tbody>
						</table>
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
											<details
												class="drawer"
												data-zmail-state-key={`finance-import-document:${row.id}`}
											>
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
						<h2>Imported transactions</h2>
						<table>
							<thead>
								<tr>
									<th>Source</th>
									<th>When</th>
									<th>Description</th>
									<th>Amount</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.importTransactions.map((row) => (
									<tr key={row.id}>
										<td>{row.sourceKind}</td>
										<td>{row.occurredAt ?? row.postedAt ?? "unknown"}</td>
										<td>{row.counterparty ?? row.description ?? "n/a"}</td>
										<td>{row.amountValue ?? "n/a"}</td>
										<td>
											<details
												class="drawer"
												data-zmail-state-key={`finance-import-transaction:${row.id}`}
											>
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.importTransactions.length === 0 ? (
									<tr>
										<td colspan={5}>No imported transactions.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</>
				) : null}

				{activeTab === "mappings" ? (
					<>
						<h2>Mapping candidates</h2>
						<table>
							<thead>
								<tr>
									<th>Confidence</th>
									<th>Impact</th>
									<th>Posting</th>
									<th>Status</th>
									<th>Evidence</th>
									<th>Action</th>
								</tr>
							</thead>
							<tbody>
								{mappingSuggestions.map((row) => {
									const suggestion = row.suggestion as unknown as Record<
										string,
										unknown
									>;
									const impact = isRecord(suggestion.impact)
										? suggestion.impact
										: {};
									const mapping = isRecord(suggestion.mapping)
										? suggestion.mapping
										: {};
									const evidence = isRecord(suggestion.evidence)
										? suggestion.evidence
										: {};
									const sampleMessageIds = Array.isArray(
										evidence.sampleMessageIds,
									)
										? evidence.sampleMessageIds.map(String).slice(0, 4)
										: [];
									const autoApplyEligible =
										suggestion.autoApplyEligible === true;
									return (
										<tr key={row.id}>
											<td>{percent(row.confidence)}</td>
											<td>
												{String(impact.rowCount ?? 0)} rows,{" "}
												{String(impact.readyUnlockEstimate ?? 0)} ready unlock
											</td>
											<td>
												<div class="stack">
													<span>{String(mapping.debitAccount ?? "n/a")}</span>
													<span>{String(mapping.creditAccount ?? "n/a")}</span>
												</div>
											</td>
											<td>
												{row.status}
												{autoApplyEligible ? " / auto" : " / review"}
											</td>
											<td>
												<div class="stack">
													<span>
														{Array.isArray(evidence.senderDomains)
															? evidence.senderDomains.map(String).join(", ")
															: "no domain"}
													</span>
													<span>
														{sampleMessageIds.map((messageId, index) => (
															<>
																{index > 0 ? ", " : ""}
																<a href={href(`/messages/${messageId}`)}>
																	{messageId}
																</a>
															</>
														))}
													</span>
													<details
														class="drawer"
														data-zmail-state-key={`mapping-candidate:${row.id}`}
													>
														<summary>Details</summary>
														<JsonBlock value={row} />
													</details>
												</div>
											</td>
											<td>
												{row.status === "pending" ? (
													<Button
														label="Apply"
														action={`/rpc/finance/mappings/suggestions/${row.id}/apply`}
														variant="secondary"
													/>
												) : (
													<span class="muted">n/a</span>
												)}
											</td>
										</tr>
									);
								})}
								{mappingSuggestions.length === 0 ? (
									<tr>
										<td colspan={6}>No mapping candidates.</td>
									</tr>
								) : null}
							</tbody>
						</table>
						<h2>YAML-backed mapping editor</h2>
						<form
							class="stack"
							data-rpc={appPath("/rpc/finance/mappings/upsert")}
						>
							<label>
								Mapping JSON
								<textarea class="input" rows={12} name="mapping">
									{json({
										mappingKey: "example",
										book: "business",
										match: { textIncludes: ["example"] },
										debitAccount: "Expenses:Business:Uncategorized",
										creditAccount: "Assets:Personal:Checking",
										currency: "USD",
										confidence: 0.85,
										notes: "Replace example before submitting.",
									})}
								</textarea>
							</label>
							<div class="actions">
								<button class="button" type="submit">
									Upsert mapping
								</button>
							</div>
						</form>
						<table>
							<thead>
								<tr>
									<th>Key</th>
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
										<td>{row.debitAccount ?? "n/a"}</td>
										<td>{row.creditAccount ?? "n/a"}</td>
										<td>{percent(row.confidence)}</td>
									</tr>
								))}
								{data.accountMappings.length === 0 ? (
									<tr>
										<td colspan={5}>No finance account mappings.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</>
				) : null}

				{activeTab === "review" ? (
					<>
						<h2>Review classifier findings</h2>
						<table>
							<thead>
								<tr>
									<th>Target</th>
									<th>Severity</th>
									<th>Action</th>
									<th>Reason</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.reviewFindings.map((row) => (
									<tr key={`${row.targetKind}:${row.targetId}:${row.action}`}>
										<td>
											{row.targetKind}:{row.targetId}
										</td>
										<td>{row.severity}</td>
										<td>{row.action}</td>
										<td>{row.reason}</td>
										<td>
											<details
												class="drawer"
												data-zmail-state-key={`review-finding:${row.targetKind}:${row.targetId}:${row.action}`}
											>
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.reviewFindings.length === 0 ? (
									<tr>
										<td colspan={5}>No review classifier findings.</td>
									</tr>
								) : null}
							</tbody>
						</table>
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
						{data.exportHealth.latestExport ? (
							<>
								<h2>Latest package</h2>
								<p class="muted">
									<code>
										mise run finance:fava --{" "}
										{data.exportHealth.latestExport.outDir}
									</code>
								</p>
								<details
									class="drawer"
									data-zmail-state-key={`finance-export-run:${data.exportHealth.latestExport.id}:manifest`}
								>
									<summary>Manifest</summary>
									<JsonBlock value={data.exportRuns[0]?.package ?? null} />
								</details>
							</>
						) : null}
					</>
				) : null}

				{activeTab === "tax" ? (
					<>
						<h2>Tax and business packages</h2>
						<form
							class="form-grid"
							data-rpc={appPath("/rpc/finance/tax/personal")}
						>
							<label>
								Personal tax year
								<input class="input" name="year" value={String(data.year)} />
							</label>
							<label>
								Output directory
								<input
									class="input"
									name="outDir"
									placeholder="personal-2025"
								/>
							</label>
							<div class="actions">
								<button class="button" type="submit">
									Queue personal package
								</button>
							</div>
						</form>
						<form
							class="form-grid"
							data-rpc={appPath("/rpc/finance/tax/business/inherent-design")}
						>
							<label>
								Business tax year
								<input class="input" name="year" value={String(data.year)} />
							</label>
							<label>
								Quarter
								<input class="input" name="quarter" value="1" />
							</label>
							<label>
								Output directory
								<input
									class="input"
									name="outDir"
									placeholder="inherent-design-2025-q1"
								/>
							</label>
							<div class="actions">
								<button class="button" type="submit">
									Queue business package
								</button>
							</div>
						</form>
						<h2>Package runs</h2>
						<table>
							<thead>
								<tr>
									<th>Status</th>
									<th>Kind</th>
									<th>Period</th>
									<th>Output</th>
									<th>Validation</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.taxReportRuns.map((row) => (
									<tr key={row.id}>
										<td>{taxRunStatusLabel(row.status)}</td>
										<td>{row.reportKind}</td>
										<td>
											{String(row.year)}
											{row.quarter ? ` Q${String(row.quarter)}` : ""}
										</td>
										<td>{row.outDir || "pending"}</td>
										<td>
											<div class="stack">
												<span>
													readiness blockers:{" "}
													{String(readinessBlockerCount(row.manifest))}
												</span>
												<span>
													ready totals:{" "}
													{row.validation &&
													typeof row.validation === "object" &&
													"acceptedTotalsUseReadyOnly" in row.validation
														? String(
																(row.validation as Record<string, unknown>)
																	.acceptedTotalsUseReadyOnly,
															)
														: "pending"}
												</span>
											</div>
										</td>
										<td>
											<details
												class="drawer"
												data-zmail-state-key={`tax-report-run:${row.id}`}
											>
												<summary>Open</summary>
												<JsonBlock value={row} />
											</details>
										</td>
									</tr>
								))}
								{data.taxReportRuns.length === 0 ? (
									<tr>
										<td colspan={6}>No tax package runs.</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</>
				) : null}
			</IslandFrame>
		),
		"finance.export-health": (
			<IslandFrame id="finance.export-health" class="card stack">
				{activeTab === "overview" ? (
					<>
						<h2>Beancount / Fava readiness</h2>
						<div class="stats compact">
							<div class="stat">
								<span class="muted">Ready</span>
								<strong>{String(data.exportHealth.readyCount)}</strong>
							</div>
							<div class="stat">
								<span class="muted">Review</span>
								<strong>{String(data.exportHealth.reviewCount)}</strong>
							</div>
							<div class="stat">
								<span class="muted">Blocked</span>
								<strong>{String(data.exportHealth.blockedCount)}</strong>
							</div>
							<div class="stat">
								<span class="muted">Latest export</span>
								<strong>
									{data.exportHealth.latestExport?.status ?? "none"}
								</strong>
							</div>
						</div>
					</>
				) : null}

				{activeTab === "exports" ? (
					<>
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
							<label>
								Overwrite
								<input name="force" type="checkbox" />
							</label>
							<div class="actions">
								<button class="button" type="submit">
									Queue export
								</button>
							</div>
						</form>
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
											<details
												class="drawer"
												data-zmail-state-key={`finance-export-run:${row.id}`}
											>
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
					</>
				) : null}
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export function renderFinancePage(
	data: FinancePageData,
	currentSearch: URLSearchParams,
) {
	const islands = renderFinanceIslandMap(data, currentSearch);
	const { activeTab } = financePageContext(data, currentSearch);
	const activeTabIsland = financeActiveTabIslandId(activeTab);
	const pageIslandIds = [
		"finance.command-bar",
		"finance.filters",
		"finance.lanes",
		"finance.summary",
		"finance.cashflow",
		"finance.categories",
		"finance.subscriptions",
		activeTabIsland,
		...(activeTab === "overview" || activeTab === "exports"
			? ["finance.export-health"]
			: []),
	];
	return <>{Array.from(new Set(pageIslandIds)).map((id) => islands[id])}</>;
}

export function renderProfileIslandMap(data: ProfilePageData) {
	return {
		"profiles.header": (
			<IslandFrame id="profiles.header" class="card stack">
				<h1>{data.account.label}</h1>
				<p class="muted">{data.account.email_address}</p>
			</IslandFrame>
		),
		"profiles.actions": (
			<IslandFrame id="profiles.actions" class="card stack">
				<div class="row">
					<h2>Profile actions</h2>
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
			</IslandFrame>
		),
		"profiles.summary": (
			<IslandFrame id="profiles.summary" class="stats compact">
				<div class="stat">
					<span class="muted">Profiles</span>
					<strong>{String(data.profiles.length)}</strong>
				</div>
				<div class="stat">
					<span class="muted">Root finance relevant</span>
					<strong>
						{String(data.financeCoverage.rootFinanceRelevantCount)}
					</strong>
				</div>
				<div class="stat">
					<span class="muted">Finance heads</span>
					<strong>{String(data.financeCoverage.totalHeads)}</strong>
				</div>
			</IslandFrame>
		),
		"profiles.findings": (
			<IslandFrame id="profiles.findings" class="stack">
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
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const PROFILE_ISLAND_IDS = [
	"profiles.header",
	"profiles.summary",
	"profiles.actions",
	"profiles.findings",
] as const;

export function renderProfilePage(data: ProfilePageData) {
	const islands = renderProfileIslandMap(data);
	return <>{PROFILE_ISLAND_IDS.map((id) => islands[id])}</>;
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

export function renderRunsIslandMap(data: RunsPageData) {
	return {
		"runs.lanes": (
			<IslandFrame id="runs.lanes" class="card stack">
				<h2>Lane state</h2>
				{renderLaneProgressCards(data.laneProgress)}
			</IslandFrame>
		),
		"runs.jobs": (
			<IslandFrame id="runs.jobs" class="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Kind</th>
							<th>Status</th>
							<th>Lane</th>
							<th>Priority</th>
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
									<td>{row.lane ?? "n/a"}</td>
									<td>{String(row.priority ?? "n/a")}</td>
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
			</IslandFrame>
		),
	} satisfies IslandRenderMap;
}

export const RUNS_ISLAND_IDS = ["runs.lanes", "runs.jobs"] as const;

export function renderRunsPage(data: RunsPageData) {
	const islands = renderRunsIslandMap(data);
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
			{RUNS_ISLAND_IDS.map((id) => islands[id])}
		</>
	);
}
