import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertAccountSyncStateRow,
	seedTestAccount,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

async function insertJob(input: {
	id: string;
	kind: string;
	scopeId: string;
	status: string;
	startedAt: string | null;
	finishedAt: string | null;
	successCount?: number;
	meta?: Record<string, unknown>;
}) {
	const { dbModule } = await bootDb();
	await dbModule
		.getDb()
		.insertInto("jobs")
		.values({
			id: input.id,
			kind: input.kind,
			scope_type: "account",
			scope_id: input.scopeId,
			status: input.status,
			model: null,
			prompt_version: null,
			request_count: 0,
			success_count: input.successCount ?? 0,
			error_count: 0,
			claimed_at: input.startedAt,
			lease_expires_at: null,
			attempts: 1,
			last_error: null,
			created_at: input.startedAt ?? "2026-01-01T00:00:00.000Z",
			started_at: input.startedAt,
			finished_at: input.finishedAt,
			meta_json: dbModule.jsonText(input.meta ?? {}),
		})
		.execute();
}

describe("sync progress", () => {
	it("returns complete backfill ETA as zero", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, { id: "acct-complete" });
		await insertAccountSyncStateRow(db, {
			accountId: "acct-complete",
			backfillSnapshotUid: 100,
			backfillNextUid: null,
		});
		const progress = await runtime.importFresh<
			typeof import("#/lib/sync-progress")
		>("#/lib/sync-progress");

		await expect(
			progress.loadAccountSyncProgress("acct-complete"),
		).resolves.toMatchObject({
			phase: "idle",
			processed: 100,
			total: 100,
			remaining: 0,
			etaSeconds: 0,
		});
	});

	it("computes active backfill ETA from recent completed jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-active",
			syncStatus: "backfilling",
		});
		await insertAccountSyncStateRow(db, {
			accountId: "acct-active",
			backfillSnapshotUid: 100,
			backfillNextUid: 40,
		});
		await insertJob({
			id: "job-rate-1",
			kind: "sync_account_backfill",
			scopeId: "acct-active",
			status: "complete",
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:00:10.000Z",
			meta: { processed: 20 },
		});
		const progress = await runtime.importFresh<
			typeof import("#/lib/sync-progress")
		>("#/lib/sync-progress");

		const snapshot = await progress.loadAccountSyncProgress("acct-active");
		expect(snapshot).toMatchObject({
			phase: "backfill",
			processed: 60,
			total: 100,
			remaining: 40,
			ratePerSecond: 2,
			etaSeconds: 20,
		});
	});

	it("returns null ETA without recent rate and no negative spans", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, { id: "acct-sparse" });
		await insertAccountSyncStateRow(db, {
			accountId: "acct-sparse",
			backfillSnapshotUid: 10,
			backfillNextUid: 20,
		});
		const progress = await runtime.importFresh<
			typeof import("#/lib/sync-progress")
		>("#/lib/sync-progress");

		const snapshot = await progress.loadAccountSyncProgress("acct-sparse");
		expect(snapshot.processed).toBe(0);
		expect(snapshot.remaining).toBe(20);
		expect(snapshot.etaSeconds).toBeNull();
	});

	it("uses running job meta for full and delta progress", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-running",
			syncStatus: "syncing",
		});
		await insertJob({
			id: "job-running",
			kind: "sync_account_delta",
			scopeId: "acct-running",
			status: "running",
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: null,
			meta: {
				phase: "delta",
				processed: 25,
				total: 100,
				updatedAt: "2026-01-01T00:00:05.000Z",
			},
		});
		const progress = await runtime.importFresh<
			typeof import("#/lib/sync-progress")
		>("#/lib/sync-progress");

		const snapshot = await progress.loadAccountSyncProgress("acct-running");
		expect(snapshot).toMatchObject({
			phase: "delta",
			processed: 25,
			total: 100,
			remaining: 75,
			etaSeconds: 30,
			updatedAt: "2026-01-01T00:00:05.000Z",
		});
	});
});
