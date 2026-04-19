import { getDb, safeJsonParse } from "#/lib/db";

export interface SyncProgressSnapshot {
	accountId: string;
	status: string;
	phase: "idle" | "full" | "delta" | "backfill" | "reconcile" | "unknown";
	processed: number | null;
	total: number | null;
	remaining: number | null;
	ratePerSecond: number | null;
	etaSeconds: number | null;
	updatedAt: string | null;
}

interface JobProgressMeta {
	phase?: string;
	processed?: number;
	total?: number | null;
	fetched?: number;
	backfillNextUid?: number | null;
	updatedAt?: string;
}

const PHASE_BY_JOB_KIND: Record<string, SyncProgressSnapshot["phase"]> = {
	sync_account_full: "full",
	sync_account_delta: "delta",
	sync_account_backfill: "backfill",
	sync_account_reconcile: "reconcile",
};

function numberOrNull(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function phaseOrUnknown(value: unknown): SyncProgressSnapshot["phase"] {
	switch (value) {
		case "idle":
		case "full":
		case "delta":
		case "backfill":
		case "reconcile":
			return value;
		case "bootstrap":
		case "resume":
			return "full";
		default:
			return "unknown";
	}
}

function computeRunningProgress(input: {
	accountId: string;
	status: string;
	runningJob:
		| {
				kind: string;
				started_at: string | null;
				meta_json: string;
		  }
		| undefined;
}): SyncProgressSnapshot | null {
	if (!input.runningJob) {
		return null;
	}
	const meta = safeJsonParse<JobProgressMeta>(input.runningJob.meta_json, {});
	const processed = numberOrNull(meta.processed ?? meta.fetched);
	const total = numberOrNull(meta.total);
	let ratePerSecond: number | null = null;
	let etaSeconds: number | null = null;
	if (
		processed !== null &&
		total !== null &&
		total > 0 &&
		input.runningJob.started_at
	) {
		const elapsedSeconds = Math.max(
			0,
			(Date.now() - new Date(input.runningJob.started_at).getTime()) / 1000,
		);
		if (elapsedSeconds > 0 && processed > 0) {
			ratePerSecond = processed / elapsedSeconds;
			etaSeconds =
				ratePerSecond > 0
					? Math.max(0, (total - processed) / ratePerSecond)
					: null;
		}
	}
	return {
		accountId: input.accountId,
		status: input.status,
		phase: phaseOrUnknown(
			meta.phase ?? PHASE_BY_JOB_KIND[input.runningJob.kind],
		),
		processed,
		total,
		remaining:
			processed !== null && total !== null
				? Math.max(0, total - processed)
				: null,
		ratePerSecond,
		etaSeconds,
		updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : null,
	};
}

function computeRatePerSecond(
	jobs: Array<{
		started_at: string | null;
		finished_at: string | null;
		success_count: number;
		meta_json: string;
	}>,
) {
	let units = 0;
	let seconds = 0;
	for (const job of jobs) {
		if (!job.started_at || !job.finished_at) {
			continue;
		}
		const durationSeconds =
			(new Date(job.finished_at).getTime() -
				new Date(job.started_at).getTime()) /
			1000;
		if (durationSeconds <= 0) {
			continue;
		}
		const meta = safeJsonParse<JobProgressMeta>(job.meta_json, {});
		const jobUnits =
			numberOrNull(meta.total) ??
			numberOrNull(meta.processed) ??
			Math.max(0, job.success_count);
		if (jobUnits <= 0) {
			continue;
		}
		units += jobUnits;
		seconds += durationSeconds;
	}
	return units > 0 && seconds > 0 ? units / seconds : null;
}

async function loadProgressSnapshots(accountId?: string) {
	const db = getDb();
	const accountQuery = db.selectFrom("accounts").select(["id", "sync_status"]);
	const accounts = await (accountId
		? accountQuery.where("id", "=", accountId).execute()
		: accountQuery.execute());
	const snapshots: SyncProgressSnapshot[] = [];

	for (const account of accounts) {
		const [syncState, runningJob, recentBackfillJobs] = await Promise.all([
			db
				.selectFrom("account_sync_state")
				.select([
					"account_id",
					"backfill_snapshot_uid",
					"backfill_next_uid",
					"updated_at",
				])
				.where("account_id", "=", account.id)
				.executeTakeFirst(),
			db
				.selectFrom("jobs")
				.select(["kind", "started_at", "meta_json"])
				.where("scope_type", "=", "account")
				.where("scope_id", "=", account.id)
				.where("status", "=", "running")
				.orderBy("started_at", "desc")
				.executeTakeFirst(),
			db
				.selectFrom("jobs")
				.select(["started_at", "finished_at", "success_count", "meta_json"])
				.where("kind", "=", "sync_account_backfill")
				.where("scope_type", "=", "account")
				.where("scope_id", "=", account.id)
				.where("finished_at", "is not", null)
				.orderBy("finished_at", "desc")
				.limit(10)
				.execute(),
		]);

		const runningProgress = computeRunningProgress({
			accountId: account.id,
			status: account.sync_status,
			runningJob,
		});
		if (runningProgress?.phase !== "backfill") {
			if (runningProgress) {
				snapshots.push(runningProgress);
				continue;
			}
		}

		const snapshotUid = syncState?.backfill_snapshot_uid ?? null;
		const nextUid = syncState?.backfill_next_uid ?? null;
		if (snapshotUid === null) {
			snapshots.push(
				runningProgress ?? {
					accountId: account.id,
					status: account.sync_status,
					phase: "idle",
					processed: null,
					total: null,
					remaining: null,
					ratePerSecond: null,
					etaSeconds: null,
					updatedAt: syncState?.updated_at ?? null,
				},
			);
			continue;
		}

		if (nextUid === null) {
			snapshots.push({
				accountId: account.id,
				status: account.sync_status,
				phase: "idle",
				processed: snapshotUid,
				total: snapshotUid,
				remaining: 0,
				ratePerSecond: null,
				etaSeconds: 0,
				updatedAt: syncState?.updated_at ?? null,
			});
			continue;
		}

		const processed = Math.max(0, snapshotUid - nextUid);
		const remaining = Math.max(0, nextUid);
		const ratePerSecond = computeRatePerSecond(recentBackfillJobs);
		snapshots.push({
			accountId: account.id,
			status: account.sync_status,
			phase: "backfill",
			processed,
			total: snapshotUid,
			remaining,
			ratePerSecond,
			etaSeconds:
				ratePerSecond !== null && ratePerSecond > 0
					? remaining / ratePerSecond
					: null,
			updatedAt: runningProgress?.updatedAt ?? syncState?.updated_at ?? null,
		});
	}

	return snapshots;
}

export async function loadAccountSyncProgress(
	accountId: string,
): Promise<SyncProgressSnapshot> {
	const snapshot = (await loadProgressSnapshots(accountId))[0];
	if (snapshot) {
		return snapshot;
	}
	return {
		accountId,
		status: "unknown",
		phase: "unknown",
		processed: null,
		total: null,
		remaining: null,
		ratePerSecond: null,
		etaSeconds: null,
		updatedAt: null,
	};
}

export async function loadAllAccountSyncProgress(): Promise<
	SyncProgressSnapshot[]
> {
	return loadProgressSnapshots();
}
