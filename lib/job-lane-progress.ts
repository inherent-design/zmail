import { getDb, safeJsonParse } from "#/lib/db";
import type { JobKind, JobLane } from "#/lib/jobs";

export type LaneState = "idle" | "queued" | "running" | "failed";

export interface JobLaneProgressSnapshot {
	lane: JobLane;
	label: string;
	state: LaneState;
	runningJobId: string | null;
	runningKind: JobKind | null;
	queuedCount: number;
	runningCount: number;
	priority: number | null;
	claimOwner: string | null;
	startedAt: string | null;
	updatedAt: string | null;
	processed: number | null;
	total: number | null;
	etaSeconds: number | null;
	lastError: string | null;
}

type JobLaneRow = {
	id: string;
	kind: string;
	lane: string;
	status: string;
	priority: number;
	claim_owner: string | null;
	started_at: string | null;
	finished_at: string | null;
	created_at: string;
	last_error: string | null;
	meta_json: string;
};

type JobProgressMeta = {
	processed?: unknown;
	total?: unknown;
	etaSeconds?: unknown;
	updatedAt?: unknown;
	phase?: unknown;
};

export const ALL_JOB_LANES = [
	"sync",
	"root_llm",
	"finance_llm",
	"review_llm",
	"materialize",
	"export_report",
	"overseer",
] as const satisfies readonly JobLane[];

export const ACCOUNT_JOB_LANES = [
	"sync",
	"root_llm",
	"finance_llm",
	"review_llm",
	"overseer",
] as const satisfies readonly JobLane[];

export const FINANCE_JOB_LANES = [
	"finance_llm",
	"review_llm",
	"materialize",
	"export_report",
] as const satisfies readonly JobLane[];

const LANE_LABELS = {
	sync: "Mailbox sync",
	root_llm: "Root classifier",
	finance_llm: "Finance classifier",
	review_llm: "Review classifier",
	materialize: "Materialize",
	export_report: "Export/report",
	overseer: "Overseer",
} satisfies Record<JobLane, string>;

function numberOrNull(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown) {
	return typeof value === "string" && value.trim() ? value : null;
}

function timeValue(value: string | null) {
	return value ? new Date(value).getTime() : 0;
}

function byOldestStart(left: JobLaneRow, right: JobLaneRow) {
	return (
		timeValue(left.started_at ?? left.created_at) -
			timeValue(right.started_at ?? right.created_at) ||
		left.created_at.localeCompare(right.created_at)
	);
}

function byQueuePriority(left: JobLaneRow, right: JobLaneRow) {
	return (
		left.priority - right.priority ||
		left.created_at.localeCompare(right.created_at)
	);
}

function progressFromMeta(job: JobLaneRow | null) {
	if (!job) {
		return {
			processed: null,
			total: null,
			etaSeconds: null,
			updatedAt: null,
		};
	}
	const meta = safeJsonParse<JobProgressMeta>(job.meta_json, {});
	return {
		processed: numberOrNull(meta.processed),
		total: numberOrNull(meta.total),
		etaSeconds: numberOrNull(meta.etaSeconds),
		updatedAt:
			stringOrNull(meta.updatedAt) ??
			job.finished_at ??
			job.started_at ??
			job.created_at,
	};
}

function emptyLane(lane: JobLane): JobLaneProgressSnapshot {
	return {
		lane,
		label: LANE_LABELS[lane],
		state: "idle",
		runningJobId: null,
		runningKind: null,
		queuedCount: 0,
		runningCount: 0,
		priority: null,
		claimOwner: null,
		startedAt: null,
		updatedAt: null,
		processed: null,
		total: null,
		etaSeconds: null,
		lastError: null,
	};
}

function snapshotForLane(
	lane: JobLane,
	rows: JobLaneRow[],
): JobLaneProgressSnapshot {
	if (rows.length === 0) {
		return emptyLane(lane);
	}
	const running = rows
		.filter((row) => row.status === "running")
		.sort(byOldestStart);
	const queued = rows
		.filter((row) => row.status === "queued")
		.sort(byQueuePriority);
	const latest = rows[0] ?? null;
	const failed =
		!running.length && !queued.length && latest?.status === "failed"
			? latest
			: null;
	const primary = running[0] ?? queued[0] ?? failed;
	const progress = progressFromMeta(primary ?? null);

	return {
		lane,
		label: LANE_LABELS[lane],
		state: running.length
			? "running"
			: queued.length
				? "queued"
				: failed
					? "failed"
					: "idle",
		runningJobId: running[0]?.id ?? null,
		runningKind: (running[0]?.kind as JobKind | undefined) ?? null,
		queuedCount: queued.length,
		runningCount: running.length,
		priority: primary?.priority ?? null,
		claimOwner: primary?.claim_owner ?? null,
		startedAt: primary?.started_at ?? null,
		updatedAt: progress.updatedAt,
		processed: progress.processed,
		total: progress.total,
		etaSeconds: progress.etaSeconds,
		lastError: primary?.last_error ?? latest?.last_error ?? null,
	};
}

async function loadLaneProgress(input: {
	lanes: readonly JobLane[];
	accountId?: string;
}) {
	const laneIds = [...input.lanes];
	const db = getDb();
	let query = db
		.selectFrom("jobs")
		.select([
			"id",
			"kind",
			"lane",
			"status",
			"priority",
			"claim_owner",
			"started_at",
			"finished_at",
			"created_at",
			"last_error",
			"meta_json",
		])
		.where("lane", "in", laneIds)
		.orderBy("created_at", "desc")
		.limit(500);

	if (input.accountId) {
		query = query
			.where("scope_type", "=", "account")
			.where("scope_id", "=", input.accountId);
	}

	const rows = (await query.execute()) as JobLaneRow[];
	const rowsByLane = new Map<JobLane, JobLaneRow[]>(
		laneIds.map((lane) => [lane, []]),
	);
	for (const row of rows) {
		if (rowsByLane.has(row.lane as JobLane)) {
			rowsByLane.get(row.lane as JobLane)?.push(row);
		}
	}

	return laneIds.map((lane) =>
		snapshotForLane(lane, rowsByLane.get(lane) ?? []),
	);
}

export function labelForJobLane(lane: JobLane) {
	return LANE_LABELS[lane];
}

export async function loadAccountLaneProgress(accountId: string) {
	return loadLaneProgress({
		lanes: ACCOUNT_JOB_LANES,
		accountId,
	});
}

export async function loadGlobalLaneProgress() {
	return loadLaneProgress({ lanes: ALL_JOB_LANES });
}

export async function loadFinanceLaneProgress() {
	return loadLaneProgress({ lanes: FINANCE_JOB_LANES });
}
