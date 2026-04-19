import { describe, expect, it, vi } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { setEnv } from "#/test/helpers/env";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("worker edge cases", () => {
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
			ensureAccountOwnershipBackfill: vi.fn(async () => undefined),
			safeJsonParse: vi.fn(
				(_value: string | null, fallback: unknown) => fallback,
			),
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
		await worker.runWorkerIteration({ waitOnIdle: false });

		expect(extendJobLease.mock.calls.length).toBeGreaterThan(1);
	});

	it("extends sync job leases on the live heartbeat while running backfill", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		const { CLASSIFY_PROMPT_VERSION } =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
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
			ensureAccountOwnershipBackfill: vi.fn(async () => undefined),
			safeJsonParse: vi.fn(
				(_value: string | null, fallback: unknown) => fallback,
			),
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
					promptVersion: CLASSIFY_PROMPT_VERSION,
				},
			],
		]);
		vi.doUnmock("#/lib/jobs");
		vi.doUnmock("#/lib/sync");
		vi.useRealTimers();
	});
});
