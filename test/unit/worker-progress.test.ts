import { describe, expect, it } from "vitest";

import { bootDb, seedTestAccount } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("worker progress", () => {
	it("updates job meta and extends lease from progress sink", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, { id: "acct-progress" });
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const jobId = await jobs.queueJob({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "acct-progress",
		});
		const claimed = jobs.claimNextJob();
		if (!claimed) {
			throw new Error("Expected queued job to be claimed");
		}
		expect(claimed.id).toBe(jobId);
		await db
			.updateTable("jobs")
			.set({ lease_expires_at: "2026-01-01T00:00:00.000Z" })
			.where("id", "=", jobId)
			.execute();
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		await worker.createJobProgressSink(claimed, "backfill").onProgress({
			phase: "backfill",
			fetched: 25,
			total: 100,
			rangeStart: 1,
			rangeEnd: 100,
			backfillNextUid: 75,
		});

		const updated = await db
			.selectFrom("jobs")
			.select(["lease_expires_at", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		const meta = JSON.parse(updated.meta_json) as Record<string, unknown>;
		expect(meta).toMatchObject({
			mode: "live",
			phase: "backfill",
			fetched: 25,
			processed: 25,
			total: 100,
			rangeStart: 1,
			rangeEnd: 100,
			backfillNextUid: 75,
		});
		expect(typeof meta.etaSeconds).toBe("number");
		expect(typeof meta.updatedAt).toBe("string");
		expect(new Date(updated.lease_expires_at ?? 0).getTime()).toBeGreaterThan(
			Date.now(),
		);
	});
});
