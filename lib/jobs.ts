import { randomUUID } from "node:crypto";

import { APP_CONFIG, nowIso } from "#/lib/config";
import { getDb, getSqlite, jsonText, safeJsonParse } from "#/lib/db";
import { startTrace } from "#/lib/log";
import { recordJobClaim } from "#/lib/observability";
import {
	publishActionEvent,
	trackRuntimeEventTask,
} from "#/lib/runtime-events";

export type JobKind =
	| "rebuild_overseer"
	| "rebuild_finance_knowledge"
	| "rebuild_finance_rollups"
	| "import_operator_registry"
	| "reconcile_registry_suggestions"
	| "import_finance_artifact"
	| "export_finance_beancount"
	| "sync_account_full"
	| "sync_account_delta"
	| "sync_account_backfill"
	| "sync_account_reconcile"
	| "classify_account_backlog"
	| "classify_finance_backlog"
	| "rebuild_category_assignments";

export interface JobRecord {
	id: string;
	kind: JobKind;
	scope_type: string;
	scope_id: string;
	status: string;
	model: string | null;
	prompt_version: string | null;
	request_count: number;
	success_count: number;
	error_count: number;
	claimed_at: string | null;
	lease_expires_at: string | null;
	attempts: number;
	last_error: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	meta_json: string;
}

function jobTopics(job: {
	kind: string;
	scope_type: string;
	scope_id: string;
}) {
	const topics = new Set<string>(["jobs"]);
	if (job.scope_type === "account") {
		topics.add(`account:${job.scope_id}`);
		topics.add("accounts");
	}
	if (
		job.scope_id === "finance" ||
		job.kind.includes("finance") ||
		job.kind.includes("registry")
	) {
		topics.add("finance");
	}
	return [...topics];
}

function publishJobEvent(
	job: {
		id: string;
		kind: string;
		scope_type: string;
		scope_id: string;
		status: string;
		request_count: number;
		success_count: number;
		error_count: number;
		last_error: string | null;
		meta_json: string;
	},
	eventType: string,
) {
	const payload = {
		jobId: job.id,
		kind: job.kind,
		scopeType: job.scope_type,
		scopeId: job.scope_id,
		status: job.status,
		requestCount: job.request_count,
		successCount: job.success_count,
		errorCount: job.error_count,
		lastError: job.last_error,
		meta: safeJsonParse(job.meta_json, {}),
	};
	for (const topic of jobTopics(job)) {
		void trackRuntimeEventTask(
			publishActionEvent({
				topic,
				eventType,
				entityKind: "job",
				entityId: job.id,
				payload,
			}),
		);
	}
}

export function parseJobMeta<T extends object>(
	job: { meta_json: string },
	fallback: T,
) {
	return safeJsonParse(job.meta_json, fallback);
}

export function isDuplicateOpenJobError(error: unknown) {
	if (!(error instanceof Error)) {
		return false;
	}

	return (
		error.message.includes("jobs_open_scope_idx") ||
		error.message.includes(
			"UNIQUE constraint failed: jobs.kind, jobs.scope_type, jobs.scope_id",
		)
	);
}

export async function findOpenJob(input: {
	kind: JobKind;
	scopeType: string;
	scopeId: string;
}) {
	const db = getDb();
	return db
		.selectFrom("jobs")
		.select(["id"])
		.where("kind", "=", input.kind)
		.where("scope_type", "=", input.scopeType)
		.where("scope_id", "=", input.scopeId)
		.where("status", "in", ["queued", "running"])
		.orderBy("created_at", "asc")
		.executeTakeFirst();
}

export async function queueJob(input: {
	kind: JobKind;
	scopeType: string;
	scopeId: string;
	model?: string | null;
	promptVersion?: string | null;
	meta?: Record<string, unknown>;
}) {
	const db = getDb();
	const id = randomUUID();
	const trace = startTrace({
		kind: "job",
		operation: "queue_job",
		job_kind: input.kind,
		scope_type: input.scopeType,
		scope_id: input.scopeId,
	});
	await db
		.insertInto("jobs")
		.values({
			id,
			kind: input.kind,
			scope_type: input.scopeType,
			scope_id: input.scopeId,
			status: "queued",
			model: input.model ?? null,
			prompt_version: input.promptVersion ?? null,
			request_count: 0,
			success_count: 0,
			error_count: 0,
			claimed_at: null,
			lease_expires_at: null,
			attempts: 0,
			last_error: null,
			created_at: nowIso(),
			started_at: null,
			finished_at: null,
			meta_json: jsonText(input.meta ?? {}),
		})
		.execute();
	publishJobEvent(
		{
			id,
			kind: input.kind,
			scope_type: input.scopeType,
			scope_id: input.scopeId,
			status: "queued",
			request_count: 0,
			success_count: 0,
			error_count: 0,
			last_error: null,
			meta_json: jsonText(input.meta ?? {}),
		},
		"job.queued",
	);
	trace.complete("job.queued", {
		job_id: id,
		model: input.model ?? undefined,
		prompt_version: input.promptVersion ?? undefined,
	});
	return id;
}

export async function queueJobIdempotent(input: {
	kind: JobKind;
	scopeType: string;
	scopeId: string;
	model?: string | null;
	promptVersion?: string | null;
	meta?: Record<string, unknown>;
}) {
	const trace = startTrace({
		kind: "job",
		operation: "queue_job_idempotent",
		job_kind: input.kind,
		scope_type: input.scopeType,
		scope_id: input.scopeId,
	});
	try {
		return await queueJob(input);
	} catch (error) {
		if (!isDuplicateOpenJobError(error)) {
			trace.fail("job.queue_duplicate_failed", error);
			throw error;
		}

		const existingJobId =
			(
				await findOpenJob({
					kind: input.kind,
					scopeType: input.scopeType,
					scopeId: input.scopeId,
				})
			)?.id ?? null;
		trace.info("job.queue_duplicate", {
			outcome: "duplicate",
			job_id: existingJobId ?? undefined,
		});
		return existingJobId;
	}
}

export function requeueExpiredJobs() {
	const sqlite = getSqlite();
	const result = sqlite
		.prepare(
			`
      UPDATE jobs
      SET status = 'queued',
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'lease expired')
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ?
      `,
		)
		.run(nowIso());

	if (result.changes > 0) {
		startTrace({
			kind: "job",
			operation: "requeue_expired_jobs",
		}).complete("job.requeued_expired", {
			processed: result.changes,
		});
	}
}

export function claimNextJob() {
	const sqlite = getSqlite();
	const now = new Date();
	const leaseExpiresAt = new Date(
		now.getTime() + APP_CONFIG.jobLeaseMs,
	).toISOString();

	const transaction = sqlite.transaction(() => {
		const row = sqlite
			.prepare(
				`
        SELECT *
        FROM jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
        `,
			)
			.get() as JobRecord | undefined;

		if (!row) {
			return null;
		}

		sqlite
			.prepare(
				`
        UPDATE jobs
        SET status = 'running',
            claimed_at = ?,
            lease_expires_at = ?,
            attempts = attempts + 1,
            started_at = COALESCE(started_at, ?),
            last_error = NULL
        WHERE id = ?
        `,
			)
			.run(now.toISOString(), leaseExpiresAt, now.toISOString(), row.id);

		return sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(row.id) as
			| JobRecord
			| undefined;
	});

	const claimed = transaction() ?? null;
	if (claimed) {
		recordJobClaim(claimed);
		publishJobEvent(claimed, "job.claimed");
		startTrace({
			kind: "job",
			operation: "claim_job",
			job_id: claimed.id,
			job_kind: claimed.kind,
			scope_type: claimed.scope_type,
			scope_id: claimed.scope_id,
		}).complete("job.claimed", {
			attempt: claimed.attempts,
		});
	}

	return claimed;
}

export async function extendJobLease(jobId: string) {
	const db = getDb();
	await db
		.updateTable("jobs")
		.set({
			lease_expires_at: new Date(
				Date.now() + APP_CONFIG.jobLeaseMs,
			).toISOString(),
		})
		.where("id", "=", jobId)
		.execute();
}

export async function updateJob(input: {
	id: string;
	status?: string;
	model?: string | null;
	promptVersion?: string | null;
	requestCount?: number;
	successCount?: number;
	errorCount?: number;
	lastError?: string | null;
	meta?: Record<string, unknown>;
	finished?: boolean;
}) {
	const db = getDb();
	const existing = await db
		.selectFrom("jobs")
		.select("meta_json")
		.where("id", "=", input.id)
		.executeTakeFirstOrThrow();
	const mergedMeta = {
		...safeJsonParse(existing.meta_json, {}),
		...(input.meta ?? {}),
	};

	await db
		.updateTable("jobs")
		.set({
			...(input.status !== undefined ? { status: input.status } : {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.promptVersion !== undefined
				? { prompt_version: input.promptVersion }
				: {}),
			...(input.requestCount !== undefined
				? { request_count: input.requestCount }
				: {}),
			...(input.successCount !== undefined
				? { success_count: input.successCount }
				: {}),
			...(input.errorCount !== undefined
				? { error_count: input.errorCount }
				: {}),
			...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
			...(input.finished
				? {
						finished_at: nowIso(),
						claimed_at: null,
						lease_expires_at: null,
					}
				: {}),
			meta_json: jsonText(mergedMeta),
		})
		.where("id", "=", input.id)
		.execute();
	const updated = await db
		.selectFrom("jobs")
		.select([
			"id",
			"kind",
			"scope_type",
			"scope_id",
			"status",
			"request_count",
			"success_count",
			"error_count",
			"last_error",
			"meta_json",
		])
		.where("id", "=", input.id)
		.executeTakeFirstOrThrow();
	publishJobEvent(updated, "job.updated");
}

export async function completeJob(input: {
	id: string;
	successCount?: number;
	errorCount?: number;
	meta?: Record<string, unknown>;
}) {
	await updateJob({
		id: input.id,
		status: "complete",
		successCount: input.successCount,
		errorCount: input.errorCount,
		meta: input.meta,
		finished: true,
	});
	startTrace({
		kind: "job",
		operation: "complete_job",
		job_id: input.id,
	}).complete("job.completed", {
		success_count: input.successCount,
		error_count: input.errorCount,
	});
}

export async function failJob(id: string, error: unknown) {
	await updateJob({
		id,
		status: "failed",
		lastError: error instanceof Error ? error.message : String(error),
		finished: true,
	});
	startTrace({
		kind: "job",
		operation: "fail_job",
		job_id: id,
	}).fail("job.failed", error);
}

export async function listJobs() {
	const db = getDb();
	return db
		.selectFrom("jobs")
		.selectAll()
		.orderBy("created_at", "desc")
		.execute();
}
