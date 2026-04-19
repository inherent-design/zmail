import client from "prom-client";

import type { ResolvedZmailConfig } from "#/lib/app-config";
import { loadResolvedConfig } from "#/lib/app-config";
import type { JobRecord } from "#/lib/jobs";
import { currentOrgId } from "#/lib/runtime";

const registry = new client.Registry();

client.collectDefaultMetrics({
	prefix: "zmail_",
	register: registry,
});

const httpRequestsTotal = new client.Counter({
	name: "zmail_http_requests_total",
	help: "HTTP requests by method, normalized route, and status class.",
	labelNames: ["method", "route", "status_class"] as const,
	registers: [registry],
});

const httpRequestDurationSeconds = new client.Histogram({
	name: "zmail_http_request_duration_seconds",
	help: "HTTP request duration by method, normalized route, and status class.",
	labelNames: ["method", "route", "status_class"] as const,
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	registers: [registry],
});

const jobClaimsTotal = new client.Counter({
	name: "zmail_worker_job_claims_total",
	help: "Worker job claims by kind and scope type.",
	labelNames: ["job_kind", "scope_type"] as const,
	registers: [registry],
});

const jobCompletedTotal = new client.Counter({
	name: "zmail_worker_job_completed_total",
	help: "Worker job completions by kind, scope type, and outcome.",
	labelNames: ["job_kind", "scope_type", "outcome"] as const,
	registers: [registry],
});

const jobDurationSeconds = new client.Histogram({
	name: "zmail_worker_job_duration_seconds",
	help: "Worker job duration by kind, scope type, and outcome.",
	labelNames: ["job_kind", "scope_type", "outcome"] as const,
	buckets: [0.1, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600, 1800],
	registers: [registry],
});

const jobsActive = new client.Gauge({
	name: "zmail_jobs_active",
	help: "Active jobs by org, kind, status, and scope type.",
	labelNames: ["org_id", "job_kind", "status", "scope_type"] as const,
	registers: [registry],
});

const oldestQueuedAgeSeconds = new client.Gauge({
	name: "zmail_jobs_oldest_queued_age_seconds",
	help: "Oldest queued job age by org and kind.",
	labelNames: ["org_id", "job_kind"] as const,
	registers: [registry],
});

const syncMessagesFetchedTotal = new client.Counter({
	name: "zmail_sync_messages_fetched_total",
	help: "Messages fetched by sync phase.",
	labelNames: ["org_id", "account_id", "phase"] as const,
	registers: [registry],
});

const syncBatchDurationSeconds = new client.Histogram({
	name: "zmail_sync_batch_duration_seconds",
	help: "Sync batch duration by phase.",
	labelNames: ["org_id", "account_id", "phase"] as const,
	buckets: [0.1, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600],
	registers: [registry],
});

const backfillRemainingUidSpan = new client.Gauge({
	name: "zmail_sync_backfill_remaining_uid_span",
	help: "Approximate remaining UID span for account backfill.",
	labelNames: ["org_id", "account_id"] as const,
	registers: [registry],
});

const backfillProcessedUidSpan = new client.Gauge({
	name: "zmail_sync_backfill_processed_uid_span",
	help: "Approximate processed UID span for account backfill.",
	labelNames: ["org_id", "account_id"] as const,
	registers: [registry],
});

const backfillProgressRatio = new client.Gauge({
	name: "zmail_sync_backfill_progress_ratio",
	help: "Approximate backfill progress ratio by account.",
	labelNames: ["org_id", "account_id"] as const,
	registers: [registry],
});

const backfillEtaSeconds = new client.Gauge({
	name: "zmail_sync_backfill_eta_seconds",
	help: "Approximate backfill ETA by account.",
	labelNames: ["org_id", "account_id"] as const,
	registers: [registry],
});

const syncAccountStatus = new client.Gauge({
	name: "zmail_sync_account_status",
	help: "One-hot account sync status by account.",
	labelNames: ["org_id", "account_id", "status"] as const,
	registers: [registry],
});

const watchersActive = new client.Gauge({
	name: "zmail_watchers_active",
	help: "Active IMAP watcher count by org.",
	labelNames: ["org_id"] as const,
	registers: [registry],
});

const ACCOUNT_STATUSES = [
	"idle",
	"syncing",
	"backfilling",
	"needs_reconnect",
	"resync_required",
	"paused",
	"error",
] as const;

export function observabilityConfig(): ResolvedZmailConfig["observability"] {
	return loadResolvedConfig().observability;
}

export function normalizeHttpRoute(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	const segments = normalizedPath.split("/").filter(Boolean);
	const [first, second, third, ...rest] = segments;

	if (segments.length === 0) {
		return "/";
	}
	if (segments.length === 1) {
		return `/${first}`;
	}
	if (first === "assets" || first === "client") {
		return `/${first}/*`;
	}
	if (first === "messages") {
		return "/messages/:messageId";
	}
	if (first === "accounts" && third === "reconnect") {
		return "/accounts/:accountId/reconnect";
	}
	if (first === "accounts" && third === "delete") {
		return "/accounts/:accountId/delete";
	}
	if (first === "accounts") {
		return "/accounts/:accountId";
	}
	if (first === "profiles") {
		return "/profiles/:accountId";
	}
	if (first === "rpc" && second === "accounts" && third) {
		return `/rpc/accounts/:accountId/${rest.join("/")}`.replace(/\/$/, "");
	}
	if (first === "rpc" && second === "messages" && third) {
		return "/rpc/messages/:messageId/classify";
	}
	if (first === "rpc" && second === "reviews" && third) {
		return "/rpc/reviews/:reviewId/resolve";
	}
	if (first === "rpc") {
		return `/${segments.slice(0, 3).join("/")}`;
	}
	return `/${first}/*`;
}

export function recordHttpRequest(input: {
	method: string;
	route: string;
	status: number;
	durationMs: number;
}): void {
	const statusClass = `${Math.floor(input.status / 100)}xx`;
	const labels = {
		method: input.method.toUpperCase(),
		route: input.route,
		status_class: statusClass,
	};
	httpRequestsTotal.inc(labels);
	httpRequestDurationSeconds.observe(labels, input.durationMs / 1000);
}

export function recordJobClaim(
	job: Pick<JobRecord, "kind" | "scope_type">,
): void {
	jobClaimsTotal.inc({
		job_kind: job.kind,
		scope_type: job.scope_type,
	});
}

export function recordJobComplete(input: {
	kind: string;
	scopeType: string;
	status: "completed" | "failed";
	durationMs: number;
}): void {
	const labels = {
		job_kind: input.kind,
		scope_type: input.scopeType,
		outcome: input.status,
	};
	jobCompletedTotal.inc(labels);
	jobDurationSeconds.observe(labels, input.durationMs / 1000);
}

export function recordSyncBatch(input: {
	orgId: string;
	accountId: string;
	phase: "full" | "delta" | "backfill" | "reconcile";
	fetched: number;
	durationMs: number;
}): void {
	const labels = {
		org_id: input.orgId,
		account_id: input.accountId,
		phase: input.phase,
	};
	syncMessagesFetchedTotal.inc(labels, Math.max(0, input.fetched));
	syncBatchDurationSeconds.observe(labels, input.durationMs / 1000);
}

async function refreshDbGauges() {
	jobsActive.reset();
	oldestQueuedAgeSeconds.reset();
	backfillRemainingUidSpan.reset();
	backfillProcessedUidSpan.reset();
	backfillProgressRatio.reset();
	backfillEtaSeconds.reset();
	syncAccountStatus.reset();
	watchersActive.reset();

	const orgId = currentOrgId();
	const [{ getDb }, { getActiveWatcherCount }, { loadAllAccountSyncProgress }] =
		await Promise.all([
			import("#/lib/db"),
			import("#/lib/watchers"),
			import("#/lib/sync-progress"),
		]);
	const db = getDb();

	const activeRows = await db
		.selectFrom("jobs")
		.select(["kind", "status", "scope_type", (eb) => eb.fn.countAll().as("count")])
		.where("status", "in", ["queued", "running"])
		.groupBy(["kind", "status", "scope_type"])
		.execute();
	for (const row of activeRows) {
		jobsActive.set(
			{
				org_id: orgId,
				job_kind: row.kind,
				status: row.status,
				scope_type: row.scope_type,
			},
			Number(row.count),
		);
	}

	const queuedRows = await db
		.selectFrom("jobs")
		.select(["kind", "created_at"])
		.where("status", "=", "queued")
		.execute();
	const nowMs = Date.now();
	const oldestByKind = new Map<string, number>();
	for (const row of queuedRows) {
		const ageSeconds = Math.max(
			0,
			(nowMs - new Date(row.created_at).getTime()) / 1000,
		);
		oldestByKind.set(
			row.kind,
			Math.max(oldestByKind.get(row.kind) ?? 0, ageSeconds),
		);
	}
	for (const [jobKind, ageSeconds] of oldestByKind) {
		oldestQueuedAgeSeconds.set(
			{
				org_id: orgId,
				job_kind: jobKind,
			},
			ageSeconds,
		);
	}

	const accounts = await db
		.selectFrom("accounts")
		.select(["id", "sync_status"])
		.execute();
	for (const account of accounts) {
		for (const status of ACCOUNT_STATUSES) {
			syncAccountStatus.set(
				{
					org_id: orgId,
					account_id: account.id,
					status,
				},
				account.sync_status === status ? 1 : 0,
			);
		}
	}

	for (const progress of await loadAllAccountSyncProgress()) {
		if (progress.remaining !== null) {
			backfillRemainingUidSpan.set(
				{ org_id: orgId, account_id: progress.accountId },
				progress.remaining,
			);
		}
		if (progress.processed !== null) {
			backfillProcessedUidSpan.set(
				{ org_id: orgId, account_id: progress.accountId },
				progress.processed,
			);
		}
		if (progress.processed !== null && progress.total && progress.total > 0) {
			backfillProgressRatio.set(
				{ org_id: orgId, account_id: progress.accountId },
				Math.min(1, Math.max(0, progress.processed / progress.total)),
			);
		}
		if (progress.etaSeconds !== null) {
			backfillEtaSeconds.set(
				{ org_id: orgId, account_id: progress.accountId },
				progress.etaSeconds,
			);
		}
	}

	watchersActive.set({ org_id: orgId }, getActiveWatcherCount());
}

export async function metricsText(): Promise<string> {
	await refreshDbGauges();
	return registry.metrics();
}

export function metricsContentType(): string {
	return registry.contentType;
}

