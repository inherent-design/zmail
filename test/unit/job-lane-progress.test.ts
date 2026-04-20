import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

async function insertJob(input: {
	id: string;
	kind: string;
	lane: string;
	scopeType?: string;
	scopeId?: string;
	status: string;
	priority?: number;
	claimOwner?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	createdAt?: string;
	lastError?: string | null;
	meta?: Record<string, unknown>;
}) {
	const { dbModule } = await bootDb();
	await dbModule
		.getDb()
		.insertInto("jobs")
		.values({
			id: input.id,
			kind: input.kind,
			scope_type: input.scopeType ?? "account",
			scope_id: input.scopeId ?? "acct-lanes",
			status: input.status,
			model: null,
			prompt_version: null,
			request_count: 0,
			success_count: 0,
			error_count: input.status === "failed" ? 1 : 0,
			claimed_at: input.startedAt ?? null,
			lease_expires_at: null,
			lane: input.lane,
			priority: input.priority ?? 100,
			run_after_at: null,
			claim_owner: input.claimOwner ?? null,
			attempts: 1,
			last_error: input.lastError ?? null,
			created_at:
				input.createdAt ?? input.startedAt ?? "2026-01-01T00:00:00.000Z",
			started_at: input.startedAt ?? null,
			finished_at: input.finishedAt ?? null,
			meta_json: dbModule.jsonText(input.meta ?? {}),
		})
		.execute();
}

describe("job lane progress", () => {
	it("groups queued and running account jobs by lane with progress metadata", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		await insertJob({
			id: "job-sync-running",
			kind: "sync_account_backfill",
			lane: "sync",
			status: "running",
			priority: 5,
			claimOwner: "worker-a",
			startedAt: "2026-01-01T00:00:00.000Z",
			meta: {
				processed: 12,
				total: 40,
				etaSeconds: 60,
				updatedAt: "2026-01-01T00:00:05.000Z",
			},
		});
		await insertJob({
			id: "job-finance-queued",
			kind: "classify_finance_backlog",
			lane: "finance_llm",
			status: "queued",
			priority: 20,
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		const lanes = await runtime.importFresh<
			typeof import("#/lib/job-lane-progress")
		>("#/lib/job-lane-progress");

		const snapshots = await lanes.loadAccountLaneProgress("acct-lanes");
		expect(snapshots.find((row) => row.lane === "sync")).toMatchObject({
			state: "running",
			runningJobId: "job-sync-running",
			runningKind: "sync_account_backfill",
			queuedCount: 0,
			runningCount: 1,
			priority: 5,
			claimOwner: "worker-a",
			processed: 12,
			total: 40,
			etaSeconds: 60,
			updatedAt: "2026-01-01T00:00:05.000Z",
		});
		expect(snapshots.find((row) => row.lane === "finance_llm")).toMatchObject({
			state: "queued",
			queuedCount: 1,
			runningCount: 0,
			priority: 20,
		});
		expect(snapshots.find((row) => row.lane === "root_llm")).toMatchObject({
			state: "idle",
			queuedCount: 0,
			runningCount: 0,
		});
	});

	it("uses the oldest running job as primary when one lane has multiple running jobs", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		await insertJob({
			id: "job-root-new",
			kind: "classify_account_backlog",
			lane: "root_llm",
			status: "running",
			startedAt: "2026-01-01T00:05:00.000Z",
		});
		await insertJob({
			id: "job-root-old",
			kind: "classify_root_messages",
			lane: "root_llm",
			status: "running",
			startedAt: "2026-01-01T00:01:00.000Z",
			meta: { processed: 2, total: 10 },
		});
		const lanes = await runtime.importFresh<
			typeof import("#/lib/job-lane-progress")
		>("#/lib/job-lane-progress");

		const rootLane = (await lanes.loadAccountLaneProgress("acct-lanes")).find(
			(row) => row.lane === "root_llm",
		);
		expect(rootLane).toMatchObject({
			state: "running",
			runningJobId: "job-root-old",
			runningKind: "classify_root_messages",
			runningCount: 2,
			processed: 2,
			total: 10,
		});
	});

	it("marks idle lanes as failed only when the latest lane job failed", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		await insertJob({
			id: "job-export-failed",
			kind: "export_finance_beancount",
			lane: "export_report",
			scopeType: "system",
			scopeId: "finance-export",
			status: "failed",
			createdAt: "2026-01-01T00:02:00.000Z",
			finishedAt: "2026-01-01T00:03:00.000Z",
			lastError: "export failed",
		});
		await insertJob({
			id: "job-materialize-complete",
			kind: "rebuild_finance_knowledge",
			lane: "materialize",
			scopeType: "system",
			scopeId: "finance",
			status: "complete",
			createdAt: "2026-01-01T00:04:00.000Z",
			finishedAt: "2026-01-01T00:05:00.000Z",
		});
		const lanes = await runtime.importFresh<
			typeof import("#/lib/job-lane-progress")
		>("#/lib/job-lane-progress");

		const snapshots = await lanes.loadFinanceLaneProgress();
		expect(snapshots.find((row) => row.lane === "export_report")).toMatchObject(
			{
				state: "failed",
				lastError: "export failed",
			},
		);
		expect(snapshots.find((row) => row.lane === "materialize")).toMatchObject({
			state: "idle",
			queuedCount: 0,
			runningCount: 0,
		});
	});
});
