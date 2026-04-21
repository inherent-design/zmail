import { describe, expect, it, vi } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("jobs", () => {
	it("queues, claims, extends, updates, completes, and fails jobs", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const queuedId = await jobs.queueJob({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-1",
			meta: { phase: "queued" },
		});
		const claimed = jobs.claimNextJob();
		expect(claimed?.id).toBe(queuedId);
		expect(claimed?.status).toBe("running");

		await jobs.extendJobLease(queuedId);
		await jobs.updateJob({
			id: queuedId,
			successCount: 1,
			errorCount: 2,
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v1",
			meta: { progress: 3 },
		});

		const updated = await dbModule
			.getDb()
			.selectFrom("jobs")
			.selectAll()
			.where("id", "=", queuedId)
			.executeTakeFirstOrThrow();

		expect(jobs.parseJobMeta(updated, {})).toMatchObject({
			phase: "queued",
			progress: 3,
		});
		expect(updated.success_count).toBe(1);
		expect(updated.error_count).toBe(2);

		await jobs.completeJob({
			id: queuedId,
			successCount: 4,
			errorCount: 2,
		});
		const completed = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["status", "finished_at"])
			.where("id", "=", queuedId)
			.executeTakeFirstOrThrow();
		expect(completed.status).toBe("complete");
		expect(completed.finished_at).toBeTruthy();

		const failedId = await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-2",
		});
		const failedClaim = jobs.claimNextJob();
		expect(failedClaim?.id).toBe(failedId);
		await jobs.failJob(failedId, new Error("boom"));
		const failed = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["status", "last_error"])
			.where("id", "=", failedId)
			.executeTakeFirstOrThrow();
		expect(failed).toMatchObject({
			status: "failed",
			last_error: "boom",
		});

		const stringFailedId = await jobs.queueJob({
			kind: "sync_account_reconcile",
			scopeType: "account",
			scopeId: "acct-3",
		});
		jobs.claimNextJob();
		await jobs.failJob(stringFailedId, "string-error");
		const stringFailed = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["last_error"])
			.where("id", "=", stringFailedId)
			.executeTakeFirstOrThrow();
		expect(stringFailed.last_error).toBe("string-error");
	});

	it("requeues expired running jobs", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const id = await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});
		jobs.claimNextJob({ claimOwner: "worker-a" });
		dbModule
			.getSqlite()
			.prepare("UPDATE jobs SET lease_expires_at = ?, status = ? WHERE id = ?")
			.run("2000-01-01T00:00:00.000Z", "running", id);

		jobs.requeueExpiredJobs();

		const row = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["status", "claimed_at", "lease_expires_at", "claim_owner"])
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

		expect(row).toMatchObject({
			status: "queued",
			claimed_at: null,
			lease_expires_at: null,
			claim_owner: null,
		});
	});

	it("emits queue, claim, completion, failure, and requeue log events", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const queuedId = await jobs.queueJob({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-log",
		});
		expect(jobs.claimNextJob()?.id).toBe(queuedId);
		await jobs.completeJob({
			id: queuedId,
			successCount: 1,
			errorCount: 0,
		});

		const failedId = await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-fail",
		});
		jobs.claimNextJob();
		await jobs.failJob(failedId, new Error("boom"));

		const requeueId = await jobs.queueJob({
			kind: "sync_account_reconcile",
			scopeType: "account",
			scopeId: "acct-requeue",
		});
		jobs.claimNextJob();
		dbModule
			.getSqlite()
			.prepare("UPDATE jobs SET lease_expires_at = ?, status = ? WHERE id = ?")
			.run("2000-01-01T00:00:00.000Z", "running", requeueId);
		jobs.requeueExpiredJobs();

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "job.queued",
					fields: expect.objectContaining({ job_id: queuedId }),
				}),
				expect.objectContaining({
					type: "complete",
					event: "job.claimed",
					fields: expect.objectContaining({ attempt: 1 }),
				}),
				expect.objectContaining({
					type: "complete",
					event: "job.completed",
					fields: expect.objectContaining({ success_count: 1 }),
				}),
				expect.objectContaining({
					type: "fail",
					event: "job.failed",
				}),
				expect.objectContaining({
					type: "complete",
					event: "job.requeued_expired",
					fields: expect.objectContaining({ processed: 1 }),
				}),
			]),
		);
	});

	it("handles duplicate open jobs idempotently", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		const firstId = await jobs.queueJobIdempotent({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "account-1",
		});
		const secondId = await jobs.queueJobIdempotent({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "account-1",
		});

		expect(firstId).toBeTruthy();
		expect(secondId).toBe(firstId);
		expect(
			jobs.isDuplicateOpenJobError(
				new Error("SQLITE_CONSTRAINT: jobs_open_scope_idx"),
			),
		).toBe(true);
		expect(
			jobs.isDuplicateOpenJobError(
				new Error(
					"UNIQUE constraint failed: jobs.kind, jobs.scope_type, jobs.scope_id",
				),
			),
		).toBe(true);
		expect(jobs.isDuplicateOpenJobError(new Error("other"))).toBe(false);

		const openJob = await jobs.findOpenJob({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "account-1",
		});
		expect(openJob?.id).toBe(firstId);
	});

	it("accepts sync_account_backfill as an idempotent open job kind", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		const firstId = await jobs.queueJobIdempotent({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "account-backfill",
		});
		const secondId = await jobs.queueJobIdempotent({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "account-backfill",
		});

		expect(firstId).toBeTruthy();
		expect(secondId).toBe(firstId);
		expect(
			await jobs.findOpenJob({
				kind: "sync_account_backfill",
				scopeType: "account",
				scopeId: "account-backfill",
			}),
		).toMatchObject({ id: firstId });
	});

	it("claims compatible jobs across lanes while excluding same-resource jobs", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const syncFullId = await jobs.queueJob({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-1",
			priority: 10,
		});
		const syncDeltaId = await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-1",
			priority: 20,
		});
		const rootId = await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
			priority: 30,
		});

		expect(jobs.claimNextJob({ claimOwner: "worker-a" })?.id).toBe(syncFullId);
		expect(jobs.claimNextJob({ claimOwner: "worker-a" })?.id).toBe(rootId);

		const blockedSync = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["id", "status"])
			.where("id", "=", syncDeltaId)
			.executeTakeFirstOrThrow();
		expect(blockedSync).toEqual({ id: syncDeltaId, status: "queued" });
	});

	it("enforces lane caps even when resource locks differ", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		const firstId = await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});
		const secondId = await jobs.queueJob({
			kind: "classify_root_messages",
			scopeType: "account",
			scopeId: "acct-2",
		});
		await jobs.queueJob({
			kind: "classify_root_messages",
			scopeType: "account",
			scopeId: "acct-3",
		});

		expect(jobs.claimNextJob()?.id).toBe(firstId);
		expect(jobs.claimNextJob()?.id).toBe(secondId);
		expect(jobs.claimNextJob()).toBeNull();
	});

	it("claims non-root lane jobs when root backlog fills the queue window", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		const runningRootId = await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-root-running",
			priority: 1,
		});
		const secondRunningRootId = await jobs.queueJob({
			kind: "classify_root_messages",
			scopeType: "account",
			scopeId: "acct-root-running-2",
			priority: 1,
		});
		expect(jobs.claimNextJob()?.id).toBe(runningRootId);
		expect(jobs.claimNextJob()?.id).toBe(secondRunningRootId);

		for (let index = 0; index < 150; index += 1) {
			await jobs.queueJob({
				kind: "classify_root_messages",
				scopeType: "account",
				scopeId: `acct-root-${index}`,
				priority: 1,
			});
		}
		const materializeId = await jobs.queueJob({
			kind: "rebuild_finance_knowledge",
			scopeType: "system",
			scopeId: "finance",
			priority: 50,
		});
		const exportId = await jobs.queueJob({
			kind: "export_finance_beancount",
			scopeType: "system",
			scopeId: "export-fairness",
			priority: 60,
		});
		const overseerId = await jobs.queueJob({
			kind: "generate_finance_mapping_candidates",
			scopeType: "system",
			scopeId: "finance_mapping_candidates",
			priority: 70,
		});

		expect(jobs.claimNextJob()?.id).toBe(materializeId);
		expect(jobs.claimNextJob()?.id).toBe(exportId);
		expect(jobs.claimNextJob()?.id).toBe(overseerId);
	});

	it("treats non-Error values as non-duplicate job errors", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		expect(jobs.isDuplicateOpenJobError("boom")).toBe(false);
	});

	it("rethrows non-duplicate queue failures and returns null when duplicate lookup finds nothing", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const duplicateError = new Error("SQLITE_CONSTRAINT: jobs_open_scope_idx");
		const insertChain = {
			values: vi.fn(() => ({
				execute: vi.fn(async () => {
					throw duplicateError;
				}),
			})),
		};
		const selectChain = {
			select: vi.fn(() => ({
				where: vi.fn(() => ({
					where: vi.fn(() => ({
						where: vi.fn(() => ({
							where: vi.fn(() => ({
								orderBy: vi.fn(() => ({
									executeTakeFirst: vi.fn(async () => undefined),
								})),
							})),
						})),
					})),
				})),
			})),
		};

		vi.doMock("#/lib/db", () => ({
			getDb: vi.fn(() => ({
				insertInto: vi.fn(() => insertChain),
				selectFrom: vi.fn(() => selectChain),
			})),
			getSqlite: vi.fn(),
			jsonText: (input: unknown) => JSON.stringify(input),
			safeJsonParse: (value: string, fallback: unknown) => {
				try {
					return JSON.parse(value);
				} catch {
					return fallback;
				}
			},
		}));

		const duplicateJobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		expect(
			await duplicateJobs.queueJobIdempotent({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: "account-2",
			}),
		).toBeNull();

		vi.resetModules();
		vi.doMock("#/lib/db", () => ({
			getDb: vi.fn(() => ({
				insertInto: vi.fn(() => ({
					values: vi.fn(() => ({
						execute: vi.fn(async () => {
							throw new Error("database offline");
						}),
					})),
				})),
				selectFrom: vi.fn(),
			})),
			getSqlite: vi.fn(),
			jsonText: (input: unknown) => JSON.stringify(input),
			safeJsonParse: (value: string, fallback: unknown) => {
				try {
					return JSON.parse(value);
				} catch {
					return fallback;
				}
			},
		}));

		const failingJobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		await expect(
			failingJobs.queueJobIdempotent({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: "account-3",
			}),
		).rejects.toThrow("database offline");
	});
});
