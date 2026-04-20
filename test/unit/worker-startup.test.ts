import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

function createEmptyWorkerDb() {
	const builder = {
		innerJoin: vi.fn(),
		leftJoin: vi.fn(),
		select: vi.fn(),
		selectAll: vi.fn(),
		where: vi.fn(),
		groupBy: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(),
		execute: vi.fn(async () => []),
		executeTakeFirst: vi.fn(async () => null),
		executeTakeFirstOrThrow: vi.fn(async () => ({ count: 0 })),
	};
	builder.innerJoin.mockReturnValue(builder);
	builder.leftJoin.mockReturnValue(builder);
	builder.select.mockReturnValue(builder);
	builder.selectAll.mockReturnValue(builder);
	builder.where.mockReturnValue(builder);
	builder.groupBy.mockReturnValue(builder);
	builder.orderBy.mockReturnValue(builder);
	builder.limit.mockReturnValue(builder);
	return {
		selectFrom: vi.fn(() => builder),
	};
}

function createWorkerDbModuleMock(input?: {
	getDb?: ReturnType<typeof vi.fn>;
	runMigrations?: ReturnType<typeof vi.fn>;
	ensureAccountOwnershipBackfill?: ReturnType<typeof vi.fn>;
}) {
	return {
		getDb: input?.getDb ?? vi.fn(() => createEmptyWorkerDb()),
		runMigrations: input?.runMigrations ?? vi.fn(),
		ensureAccountOwnershipBackfill:
			input?.ensureAccountOwnershipBackfill ?? vi.fn(async () => undefined),
		safeJsonParse: vi.fn(
			(_value: string | null, fallback: unknown) => fallback,
		),
	};
}

describe("worker edge cases", () => {
	beforeEach(() => {
		vi.useRealTimers();
		delete globalThis.__zmailWorkerStarted__;
		delete globalThis.__zmailWorkerLoop__;
		delete globalThis.__zmailOrgWorkerLoops__;
	});

	it("does not start when RUN_WORKER is false", async () => {
		const runtime = await createTestRuntime();
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");

		worker.ensureWorkerStarted();

		expect(globalThis.__zmailWorkerStarted__).toBeUndefined();
	});

	it("keeps the supervisor active after an in-loop crash and allows restart", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		process.env.RUN_WORKER = "true";
		process.env.ZMAIL_WORKER_POLL_MS = "1";
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const runMigrations = vi.fn();
		const requeueExpiredJobs = vi.fn();
		const getDb = vi.fn(() => createEmptyWorkerDb());
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

		vi.doMock("#/lib/db", () =>
			createWorkerDbModuleMock({
				getDb,
				runMigrations,
			}),
		);
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
		vi.doMock("#/lib/category-rules", () => ({
			listPendingMessageCategoryAssignmentIds: vi.fn(async () => []),
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
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(2);
		expect(claimNextJob).toHaveBeenCalledTimes(2);
		expect(globalThis.__zmailWorkerStarted__).toBe(true);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		expect(globalThis.__zmailOrgWorkerLoops__?.size ?? 0).toBe(0);
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
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(4);
		expect(claimNextJob).toHaveBeenCalledTimes(4);
		expect(globalThis.__zmailWorkerStarted__).toBe(true);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		expect(globalThis.__zmailOrgWorkerLoops__?.size ?? 0).toBe(0);
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
		const getDb = vi.fn(() => createEmptyWorkerDb());
		const claimNextJob = vi
			.fn()
			.mockReturnValueOnce(null)
			.mockImplementationOnce(() => {
				throw new Error("stop-loop");
			});

		vi.doMock("#/lib/db", () =>
			createWorkerDbModuleMock({
				getDb,
				runMigrations,
			}),
		);
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
		vi.doMock("#/lib/category-rules", () => ({
			listPendingMessageCategoryAssignmentIds: vi.fn(async () => []),
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

	it("keeps the supervisor active after startup failure and logs the crash", async () => {
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
		const getDb = vi.fn(() => createEmptyWorkerDb());
		const claimNextJob = vi
			.fn()
			.mockReturnValueOnce(null)
			.mockImplementationOnce(() => {
				throw new Error("stop-loop-after-restart");
			});

		vi.doMock("#/lib/db", () =>
			createWorkerDbModuleMock({
				getDb,
				runMigrations,
			}),
		);
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
		vi.doMock("#/lib/category-rules", () => ({
			listPendingMessageCategoryAssignmentIds: vi.fn(async () => []),
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
		expect(globalThis.__zmailWorkerStarted__).toBe(true);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		expect(globalThis.__zmailOrgWorkerLoops__?.size ?? 0).toBe(0);
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
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(2);
		expect(claimNextJob).toHaveBeenCalledTimes(2);
		expect(globalThis.__zmailWorkerStarted__).toBe(true);
		expect(globalThis.__zmailWorkerLoop__).toBeUndefined();
		vi.useRealTimers();
	});

	it("starts one loop per discovered org runtime and isolates a crash to one org loop", async () => {
		vi.useFakeTimers();
		const runtime = await createTestRuntime();
		process.env.RUN_WORKER = "true";
		process.env.ZMAIL_WORKER_POLL_MS = "1";
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const stopOrgs = new Set(["org-a", "org-b"]);
		const claimCounts = new Map<string, number>();

		vi.doMock("#/lib/runtime", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/runtime")>("#/lib/runtime");
			return {
				...actual,
				discoverOrgRuntimeIds: vi.fn(() => ["org-a", "org-b"]),
			};
		});
		const runtimeModule =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);

		const runMigrations = vi.fn();
		const requeueExpiredJobs = vi.fn();
		const getDb = vi.fn(() => createEmptyWorkerDb());
		const claimNextJob = vi.fn(() => {
			const activeOrgId = runtimeModule.currentOrgId();
			const count = claimCounts.get(activeOrgId) ?? 0;
			claimCounts.set(activeOrgId, count + 1);
			if (count === 0) {
				return null;
			}
			if (stopOrgs.has(activeOrgId)) {
				throw new Error(`stop-${activeOrgId}`);
			}
			return null;
		});

		vi.doMock("#/lib/db", () =>
			createWorkerDbModuleMock({
				getDb,
				runMigrations,
			}),
		);
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
		vi.doMock("#/lib/category-rules", () => ({
			listPendingMessageCategoryAssignmentIds: vi.fn(async () => []),
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
		expect(globalThis.__zmailOrgWorkerLoops__?.size).toBe(2);

		await vi.advanceTimersByTimeAsync(500);

		expect(runMigrations).toHaveBeenCalledTimes(2);
		expect(requeueExpiredJobs).toHaveBeenCalledTimes(2);
		expect(globalThis.__zmailWorkerStarted__).toBe(true);
		expect(globalThis.__zmailOrgWorkerLoops__?.size ?? 0).toBe(1);
		expect(
			log.records.filter(
				(record) =>
					record.type === "fail" && record.event === "worker.loop_crashed",
			),
		).toHaveLength(1);
		vi.useRealTimers();
	});
});
