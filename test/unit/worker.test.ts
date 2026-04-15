import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertMessageLabelRow,
	insertMessageRow,
} from "#/test/helpers/db";
import { setEnv } from "#/test/helpers/env";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

function createEmptyBackfillScannerDb() {
	const builder = {
		innerJoin: vi.fn(),
		select: vi.fn(),
		where: vi.fn(),
		execute: vi.fn(async () => []),
	};
	builder.innerJoin.mockReturnValue(builder);
	builder.select.mockReturnValue(builder);
	builder.where.mockReturnValue(builder);
	return {
		selectFrom: vi.fn(() => builder),
	};
}

describe("worker edge cases", () => {
	it("does not start when RUN_WORKER is false", async () => {
		const runtime = await createTestRuntime();
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		worker.ensureWorkerStarted();

		expect(globalThis.__zmailWorkerStarted__).toBeUndefined();
	});

	it("resets the worker latch after an in-loop crash and allows restart", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		process.env.RUN_WORKER = "true";
		process.env.ZMAIL_WORKER_POLL_MS = "1";
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const runMigrations = vi.fn();
		const requeueExpiredJobs = vi.fn();
		const getDb = vi.fn(() => createEmptyBackfillScannerDb());
		const claimNextJob = vi
			.fn()
			.mockReturnValueOnce(null)
			.mockImplementationOnce(() => {
				throw new Error("stop-loop");
			})
			.mockReturnValueOnce(null)
			.mockImplementationOnce(() => {
				throw new Error("stop-loop-restarted");
			});

		vi.doMock("#/lib/db", () => ({
			getDb,
			runMigrations,
		}));
		vi.doMock("#/lib/jobs", () => ({
			claimNextJob,
			completeJob: vi.fn(),
			extendJobLease: vi.fn(),
			failJob: vi.fn(),
			findOpenJob: vi.fn(async () => null),
			queueJobIdempotent: vi.fn(),
			requeueExpiredJobs,
			updateJob: vi.fn(),
		}));
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(),
			classifyMessageNow: vi.fn(),
			mergeAllowedTags: vi.fn(),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(),
			topModerationScores: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(),
			maybeQueueOverseerForAccount: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			restoreWatchers: vi.fn(async () => undefined),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		worker.ensureWorkerStarted();
		worker.ensureWorkerStarted();
		const firstLoopPromise = globalThis.__zmailWorkerLoop__;
		await vi.advanceTimersByTimeAsync(50);
		await firstLoopPromise;

		expect(runMigrations).toHaveBeenCalledTimes(1);
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(1);
		expect(claimNextJob).toHaveBeenCalledTimes(2);
		expect(globalThis.__zmailWorkerStarted__).toBe(false);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		expect(
			log.records.filter(
				(record) =>
					record.type === "fail" && record.event === "worker.loop_crashed",
			),
		).toHaveLength(1);

		worker.ensureWorkerStarted();
		const secondLoopPromise = globalThis.__zmailWorkerLoop__;
		await vi.advanceTimersByTimeAsync(50);
		await secondLoopPromise;

		expect(runMigrations).toHaveBeenCalledTimes(2);
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(2);
		expect(claimNextJob).toHaveBeenCalledTimes(4);
		expect(globalThis.__zmailWorkerStarted__).toBe(false);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		expect(
			log.records.filter(
				(record) =>
					record.type === "fail" && record.event === "worker.loop_crashed",
			),
		).toHaveLength(2);
		vi.useRealTimers();
	});

	it("continues startup when watcher restoration fails", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		process.env.RUN_WORKER = "true";
		process.env.ZMAIL_WORKER_POLL_MS = "1";
		vi.resetModules();

		const runMigrations = vi.fn();
		const requeueExpiredJobs = vi.fn();
		const getDb = vi.fn(() => createEmptyBackfillScannerDb());
		const claimNextJob = vi
			.fn()
			.mockReturnValueOnce(null)
			.mockImplementationOnce(() => {
				throw new Error("stop-loop");
			});

		vi.doMock("#/lib/db", () => ({
			getDb,
			runMigrations,
		}));
		vi.doMock("#/lib/jobs", () => ({
			claimNextJob,
			completeJob: vi.fn(),
			extendJobLease: vi.fn(),
			failJob: vi.fn(),
			findOpenJob: vi.fn(async () => null),
			queueJobIdempotent: vi.fn(),
			requeueExpiredJobs,
			updateJob: vi.fn(),
		}));
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(),
			classifyMessageNow: vi.fn(),
			mergeAllowedTags: vi.fn(),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(),
			topModerationScores: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(),
			maybeQueueOverseerForAccount: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			restoreWatchers: vi.fn(async () => {
				throw new Error("restore failed");
			}),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		worker.ensureWorkerStarted();
		const loopPromise = globalThis.__zmailWorkerLoop__?.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(50);
		await loopPromise;

		expect(runMigrations).toHaveBeenCalled();
		expect(requeueExpiredJobs).toHaveBeenCalled();
		expect(claimNextJob).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("resets the worker latch after startup failure and logs the crash", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		process.env.RUN_WORKER = "true";
		process.env.ZMAIL_WORKER_POLL_MS = "1";
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const runMigrations = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("migration failed");
			})
			.mockImplementation(() => undefined);
		const requeueExpiredJobs = vi.fn();
		const getDb = vi.fn(() => createEmptyBackfillScannerDb());
		const claimNextJob = vi
			.fn()
			.mockReturnValueOnce(null)
			.mockImplementationOnce(() => {
				throw new Error("stop-loop-after-restart");
			});

		vi.doMock("#/lib/db", () => ({
			getDb,
			runMigrations,
		}));
		vi.doMock("#/lib/jobs", () => ({
			claimNextJob,
			completeJob: vi.fn(),
			extendJobLease: vi.fn(),
			failJob: vi.fn(),
			findOpenJob: vi.fn(async () => null),
			queueJobIdempotent: vi.fn(),
			requeueExpiredJobs,
			updateJob: vi.fn(),
		}));
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(),
			classifyMessageNow: vi.fn(),
			mergeAllowedTags: vi.fn(),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(),
			topModerationScores: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(),
			maybeQueueOverseerForAccount: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			restoreWatchers: vi.fn(async () => undefined),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		worker.ensureWorkerStarted();
		await globalThis.__zmailWorkerLoop__;

		expect(runMigrations).toHaveBeenCalledTimes(1);
		expect(requeueExpiredJobs).not.toHaveBeenCalled();
		expect(globalThis.__zmailWorkerStarted__).toBe(false);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "fail",
					event: "worker.loop_crashed",
				}),
			]),
		);

		worker.ensureWorkerStarted();
		const restartedLoopPromise = globalThis.__zmailWorkerLoop__;
		await vi.advanceTimersByTimeAsync(50);
		await restartedLoopPromise;

		expect(runMigrations).toHaveBeenCalledTimes(2);
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(1);
		expect(claimNextJob).toHaveBeenCalledTimes(2);
		expect(globalThis.__zmailWorkerStarted__).toBe(false);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		vi.useRealTimers();
	});

	it("waits when idle and fails bad jobs inside one worker iteration", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		process.env.ZMAIL_WORKER_POLL_MS = "1";
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const failJob = vi.fn(async () => undefined);
		const claimNextJob = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce({
			id: "bad-job",
			kind: "not-real",
		});

		vi.doMock("#/lib/db", () => ({
			getDb: vi.fn(),
			runMigrations: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", () => ({
			claimNextJob,
			completeJob: vi.fn(),
			extendJobLease: vi.fn(),
			failJob,
			queueJob: vi.fn(),
			requeueExpiredJobs: vi.fn(),
			updateJob: vi.fn(),
		}));
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(),
			classifyMessageNow: vi.fn(),
			mergeAllowedTags: vi.fn(),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(),
			topModerationScores: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(),
			maybeQueueOverseerForAccount: vi.fn(),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		const idlePromise = worker.runWorkerIteration({ waitOnIdle: true });
		await vi.advanceTimersByTimeAsync(5);
		await idlePromise;
		await worker.runWorkerIteration({ waitOnIdle: false });

		expect(claimNextJob).toHaveBeenCalledTimes(2);
		expect(failJob).toHaveBeenCalledWith("bad-job", expect.any(Error));
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "worker.job_start",
				}),
				expect.objectContaining({
					type: "fail",
					event: "worker.job_fail",
				}),
			]),
		);
		vi.useRealTimers();
	});

	it("extends backlog job leases on the live heartbeat while classifying", async () => {
		const runtime = await createTestRuntime();
		setEnv({
			ZMAIL_LIVE_HEARTBEAT_MS: "1",
			ZMAIL_LIVE_CONCURRENCY: "1",
		});
		vi.resetModules();

		vi.doMock("#/lib/db", async () => {
			return await vi.importActual<typeof import("#/lib/db")>("#/lib/db");
		});
		const extendJobLease = vi.fn(async () => undefined);
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				extendJobLease,
			};
		});
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(() => "No attachments"),
			classifyMessageNow: vi.fn(
				async () =>
					await new Promise((resolve) => {
						setTimeout(resolve, 25);
					}),
			),
			mergeAllowedTags: vi.fn((tags: string[]) => tags),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(async () => ({
				nsfwFlag: false,
				scores: {},
			})),
			topModerationScores: vi.fn(() => []),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(async () => ({
				promptPreamble: null,
				promotedTags: [],
				profile: null,
			})),
			maybeQueueOverseerForAccount: vi.fn(async () => false),
		}));

		const { db } = await bootDb({ seedDefaultAccount: true });
		await insertMessageRow(db, {
			id: "msg-heartbeat",
			accountId: "acct-1",
			contentSha256: "sha-heartbeat",
		});

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await worker.drainWorkerUntilIdle();

		expect(extendJobLease.mock.calls.length).toBeGreaterThan(1);
	});

	it("extends sync job leases on the live heartbeat while running backfill", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		setEnv({
			ZMAIL_LIVE_HEARTBEAT_MS: "1",
		});
		vi.resetModules();

		const completeJob = vi.fn(async () => undefined);
		const extendJobLease = vi.fn(async () => undefined);
		const queueJobIdempotent = vi.fn(async () => "queued-backlog");
		const claimNextJob = vi.fn().mockReturnValueOnce({
			id: "job-backfill",
			kind: "sync_account_backfill",
			scope_type: "account",
			scope_id: "acct-1",
		});

		vi.doMock("#/lib/db", () => ({
			getDb: vi.fn(),
			runMigrations: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				claimNextJob,
				completeJob,
				extendJobLease,
				failJob: vi.fn(),
				queueJobIdempotent,
				requeueExpiredJobs: vi.fn(),
				updateJob: vi.fn(),
			};
		});
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(),
			classifyMessageNow: vi.fn(),
			mergeAllowedTags: vi.fn(),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(),
			topModerationScores: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(),
			maybeQueueOverseerForAccount: vi.fn(),
		}));
		vi.doMock("#/lib/sync", () => ({
			runBackfillSync: vi.fn(
				async () =>
					await new Promise((resolve) => {
						setTimeout(
							() =>
								resolve({
									skipped: false,
									fetched: 2,
									earliestUidCursor: 3,
									backfillNextUid: 2,
									rangeStart: null,
									rangeEnd: null,
									queuedMore: true,
									uidvalidityChanged: false,
								}),
							25,
						);
					}),
			),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		const runPromise = worker.runWorkerIteration({ waitOnIdle: false });
		await vi.advanceTimersByTimeAsync(50);
		await runPromise;

		expect(extendJobLease.mock.calls.length).toBeGreaterThan(1);
		expect(completeJob).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "job-backfill",
				meta: expect.objectContaining({
					phase: "backfill",
					total: 2,
				}),
			}),
		);
		expect(queueJobIdempotent.mock.calls).toEqual([
			[
				{
					kind: "sync_account_backfill",
					scopeType: "account",
					scopeId: "acct-1",
				},
			],
			[
				{
					kind: "classify_account_backlog",
					scopeType: "account",
					scopeId: "acct-1",
					model: "gpt-5.4-mini",
					promptVersion: "classify-email-v1",
				},
			],
		]);
		vi.doUnmock("#/lib/jobs");
		vi.doUnmock("#/lib/sync");
		vi.useRealTimers();
	});

	it("requeues missing backfill jobs from sync state before draining", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		vi.doUnmock("#/lib/db");
		vi.doUnmock("#/lib/jobs");

		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("account_sync_state")
			.values({
				account_id: "acct-1",
				uidvalidity: 100,
				latest_uid_cursor: 50,
				earliest_uid_cursor: 25,
				backfill_snapshot_uid: 50,
				backfill_next_uid: 24,
				last_bootstrap_started_at: "2026-01-01T00:00:00.000Z",
				last_bootstrap_completed_at: "2026-01-01T00:00:01.000Z",
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: "2026-01-01T00:00:02.000Z",
				backfill_completed_at: null,
				last_idle_started_at: null,
				last_idle_heartbeat_at: null,
				watcher_status: "idle",
				consecutive_failures: 0,
				backoff_until: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:02.000Z",
			})
			.execute();

		vi.doMock("#/lib/sync", () => ({
			runBackfillSync: vi.fn(async () => ({
				skipped: false,
				fetched: 0,
				earliestUidCursor: 1,
				backfillNextUid: null,
				rangeStart: 1,
				rangeEnd: 24,
				queuedMore: false,
				uidvalidityChanged: false,
			})),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		await worker.drainWorkerUntilIdle();

		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "status", "scope_id"])
			.orderBy("created_at")
			.execute();
		expect(jobs).toEqual([
			{
				kind: "sync_account_backfill",
				status: "complete",
				scope_id: "acct-1",
			},
		]);
		vi.doUnmock("#/lib/sync");
	});

	it("queues root backlog when only moderation prompt freshness is stale", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const { MODERATION_PROMPT_VERSION, nowIso } =
			await runtime.importFresh<typeof import("#/lib/config")>(
				"#/lib/config",
			);
		const messageId = await insertMessageRow(db, {
			id: "msg-stale-moderation-only",
			accountId: "acct-1",
			contentSha256: "sha-stale-moderation-only",
		});
		await insertMessageLabelRow(db, {
			messageId,
			contentSha256: "sha-stale-moderation-only",
		});
		await db
			.insertInto("moderation_results")
			.values({
				id: "moderation-stale-only",
				job_id: null,
				message_id: messageId,
				model: "gpt-5.4-mini",
				categories_json: JSON.stringify({
					explicitSexual: false,
					suggestiveSexual: false,
					nudity: false,
					sexualMinors: false,
					adultCommercial: false,
				}),
				category_scores_json: JSON.stringify({
					explicitSexual: 0,
					suggestiveSexual: 0,
					nudity: 0,
					sexualMinors: 0,
					adultCommercial: 0,
					overall: 0,
				}),
				raw_response_json: JSON.stringify({
					promptVersion: "moderate-email-v1",
					rawResponse: { assistantText: "{}" },
				}),
				nsfw_flag: 0,
				created_at: nowIso(),
			})
			.execute();

		const ensureModerationForMessage = vi.fn(
			async ({ messageId: currentId }: { messageId: string }) => {
				await db
					.updateTable("moderation_results")
					.set({
						raw_response_json: JSON.stringify({
							promptVersion: MODERATION_PROMPT_VERSION,
							rawResponse: { assistantText: "{}" },
						}),
						category_scores_json: JSON.stringify({}),
						nsfw_flag: 0,
						created_at: nowIso(),
					})
					.where("message_id", "=", currentId)
					.execute();
				return {
					nsfwFlag: false,
					scores: {},
				};
			},
		);
		const classifyMessageNow = vi.fn(async () => undefined);

		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(() => "No attachments"),
			classifyMessageNow,
			mergeAllowedTags: vi.fn((tags: string[]) => tags),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage,
			topModerationScores: vi.fn(() => []),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(async () => ({
				promptPreamble: null,
				promotedTags: [],
				profile: null,
			})),
			maybeQueueOverseerForAccount: vi.fn(async () => false),
		}));
		vi.doMock("#/lib/category-rules", () => ({
			listPendingMessageCategoryAssignmentIds: vi.fn(async () => []),
			projectMessageCategoryAssignment: vi.fn(async () => undefined),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		await worker.drainWorkerUntilIdle();

		expect(ensureModerationForMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: expect.any(String),
				messageId,
			}),
		);
		expect(classifyMessageNow).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId,
				moderationFlag: false,
			}),
		);

		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "status", "scope_id"])
			.where("kind", "=", "classify_account_backlog")
			.execute();
		expect(jobs).toEqual(
			expect.arrayContaining([
				{
					kind: "classify_account_backlog",
					status: "complete",
					scope_id: "acct-1",
				},
			]),
		);
		vi.doUnmock("#/lib/category-rules");
		vi.doUnmock("#/lib/classify");
		vi.doUnmock("#/lib/moderation");
		vi.doUnmock("#/lib/overseer");
	});

	it("emits backlog progress and worker completion events", async () => {
		const runtime = await createTestRuntime();
		setEnv({
			ZMAIL_LIVE_HEARTBEAT_MS: "1",
			ZMAIL_LIVE_CONCURRENCY: "1",
		});
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		vi.doMock("#/lib/db", async () => {
			return await vi.importActual<typeof import("#/lib/db")>("#/lib/db");
		});
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(() => "No attachments"),
			classifyMessageNow: vi.fn(async () => undefined),
			mergeAllowedTags: vi.fn((tags: string[]) => tags),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(async () => ({
				nsfwFlag: false,
				scores: {},
			})),
			topModerationScores: vi.fn(() => []),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(async () => ({
				promptPreamble: null,
				promotedTags: [],
				profile: null,
			})),
			maybeQueueOverseerForAccount: vi.fn(async () => false),
		}));

		const { db } = await bootDb({ seedDefaultAccount: true });
		for (let index = 0; index < 26; index += 1) {
			await insertMessageRow(db, {
				id: `msg-${index}`,
				accountId: "acct-1",
				contentSha256: `sha-${index}`,
			});
		}

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await worker.drainWorkerUntilIdle();

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "worker.job_start",
				}),
				expect.objectContaining({
					type: "info",
					event: "worker.classify_backlog.progress",
					fields: expect.objectContaining({ processed: 25, total: 26 }),
				}),
				expect.objectContaining({
					type: "complete",
					event: "worker.classify_backlog.complete",
					fields: expect.objectContaining({ processed: 26, total: 26 }),
				}),
				expect.objectContaining({
					type: "complete",
					event: "worker.job_complete",
				}),
			]),
		);
	});

	it("uses range metadata to compute backfill totals when the bounds are present", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const completeJob = vi.fn(async () => undefined);
		const claimNextJob = vi.fn().mockReturnValueOnce({
			id: "job-backfill-range",
			kind: "sync_account_backfill",
			scope_type: "account",
			scope_id: "acct-1",
		});

		vi.doMock("#/lib/db", () => ({
			getDb: vi.fn(),
			runMigrations: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				claimNextJob,
				completeJob,
				extendJobLease: vi.fn(async () => undefined),
				failJob: vi.fn(),
				queueJobIdempotent: vi.fn(async () => null),
				requeueExpiredJobs: vi.fn(),
				updateJob: vi.fn(),
			};
		});
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(),
			classifyMessageNow: vi.fn(),
			mergeAllowedTags: vi.fn(),
		}));
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage: vi.fn(),
			topModerationScores: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile: vi.fn(),
			loadLatestOverseerContext: vi.fn(),
			maybeQueueOverseerForAccount: vi.fn(),
		}));
		vi.doMock("#/lib/sync", () => ({
			runBackfillSync: vi.fn(async () => ({
				skipped: false,
				fetched: 1,
				earliestUidCursor: 3,
				backfillNextUid: 2,
				rangeStart: 3,
				rangeEnd: 5,
				queuedMore: false,
				uidvalidityChanged: false,
			})),
		}));

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		await worker.runWorkerIteration({ waitOnIdle: false });

		expect(completeJob).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "job-backfill-range",
				meta: expect.objectContaining({
					phase: "backfill",
					total: 3,
				}),
			}),
		);
		vi.doUnmock("#/lib/jobs");
		vi.doUnmock("#/lib/sync");
	});
});
