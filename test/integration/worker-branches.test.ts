import { describe, expect, it, vi } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { buildMessageLabelV3 } from "#/test/helpers/labels";
import { createTestRuntime } from "#/test/helpers/runtime";

function mockSelectivePi(errorMode: "string" | "error" = "string") {
	vi.doMock("#/lib/pi", () => ({
		piJson: vi.fn(async (input: { userPrompt: string }) => {
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			if (input.userPrompt.includes("Allowed tags:")) {
				if (input.userPrompt.includes("bad-classification-marker")) {
					if (errorMode === "error") {
						throw new Error("classification failed");
					}
					throw "classification failed";
				}

				return {
					backend: "openai-subscription",
					modelId: "gpt-5.4-mini",
					parsed: buildMessageLabelV3({
						finance: {
							relevant: true,
							signal: "receipt",
							operational: true,
							bookHint: "business",
							requiresFinanceIntel: true,
							confidence: 0.95,
							evidence: "Client lunch receipt.",
						},
						routing: {
							primaryBucket: "finance",
							secondaryBuckets: ["receipt"],
							tags: ["receipt"],
						},
						confidence: {
							overall: 0.95,
							finance: 0.95,
							people: 0.95,
							commerce: 0.95,
							knowledge: 0.95,
							assets: 0.95,
							entertainment: 0.95,
							risk: 0.95,
						},
						explanation: "ok",
					}),
					rawText: "{}",
					usage: null,
				};
			}

			if (input.userPrompt.includes("Bad moderation")) {
				if (errorMode === "error") {
					throw new Error("moderation failed");
				}
				throw "moderation failed";
			}

			return {
				backend: "openai-subscription",
				modelId: "gpt-5.4-mini",
				parsed: {
					schemaVersion: "message-moderation.v1",
					nsfw: false,
					categories: {
						explicitSexual: false,
						suggestiveSexual: false,
						nudity: false,
						sexualMinors: false,
						adultCommercial: false,
					},
					scores: {
						explicitSexual: 0.1,
						suggestiveSexual: 0.1,
						nudity: 0.1,
						sexualMinors: 0,
						adultCommercial: 0.1,
						overall: 0.1,
					},
					explanation: "safe",
				},
				rawText: "{}",
				usage: null,
			};
		}),
		getPiStatus: vi.fn(async () => ({
			subscriptionConfigured: true,
			apiConfigured: false,
			preferredBackend: "auto",
			resolvedBackend: "openai-subscription",
		})),
	}));
}

describe("worker branch coverage", () => {
	it("starts the watcher after a successful full sync and queues backlog work", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });

		const startWatcher = vi.fn(async () => undefined);
		const queueJobIdempotent = vi.fn(async () => "queued-backlog");
		vi.doMock("#/lib/sync", () => ({
			runFullSync: vi.fn(async () => ({
				skipped: false,
				phase: "bootstrap",
				fetched: 2,
				latestUidCursor: 42,
				earliestUidCursor: 41,
				backfillSnapshotUid: 42,
				backfillNextUid: null,
				queuedBackfill: false,
				queuedDelta: false,
			})),
		}));
		vi.doMock("#/lib/watchers", () => ({
			startWatcher,
			restoreWatchers: vi.fn(async () => undefined),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		await jobs.queueJob({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await worker.runWorkerIteration({ waitOnIdle: false });

		expect(startWatcher).toHaveBeenCalledWith("acct-1", expect.any(Object));
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v3",
		});
	});

	it("runs delta, reconcile, and empty backlog account jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const queueJobIdempotent = vi.fn(async () => "queued-backlog");

		vi.doMock("#/lib/sync", () => ({
			runDeltaSync: vi.fn(async () => ({
				fetched: 1,
				uidvalidityChanged: false,
			})),
			runReconcile: vi.fn(async () => ({
				tombstoned: 2,
			})),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await jobs.queueJob({
			kind: "sync_account_reconcile",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await worker.drainWorkerUntilIdle();

		const rows = await db
			.selectFrom("jobs")
			.select(["kind", "status", "success_count"])
			.where("scope_id", "=", "acct-1")
			.orderBy("created_at")
			.execute();

		expect(rows.some((row) => row.kind === "sync_account_delta")).toBe(true);
		expect(rows.some((row) => row.kind === "sync_account_reconcile")).toBe(
			true,
		);
		expect(
			rows.some(
				(row) =>
					row.kind === "classify_account_backlog" &&
					row.status === "complete" &&
					row.success_count === 0,
			),
		).toBe(true);
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v3",
		});
	});

	it("records backlog classification failures while classifying the rest", async () => {
		const runtime = await createTestRuntime();
		mockSelectivePi("error");
		const buildOverseerProfile = vi.fn(async () => undefined);
		vi.doMock("#/lib/jobs", async () => {
			return await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
		});
		vi.doMock("#/lib/overseer", () => ({
			buildOverseerProfile,
			loadLatestOverseerContext: vi.fn(async () => ({
				promptPreamble: null,
				promotedTags: [],
				profile: null,
			})),
			maybeQueueOverseerForAccount: vi.fn(async () => true),
		}));

		const { db } = await bootDb({ seedDefaultAccount: true });
		const goodMessageId = await insertMessageRow(db, {
			id: "msg-good",
			accountId: "acct-1",
			subject: "Good classification",
			bodyTextNormalized: "good body",
			contentSha256: "sha-good",
		});
		const badMessageId = await insertMessageRow(db, {
			id: "msg-bad",
			accountId: "acct-1",
			senderAddress: null,
			subject: null,
			receivedAt: null,
			bodyTextNormalized: "bad-classification-marker",
			contentSha256: "sha-bad",
		});
		await db
			.insertInto("attachments")
			.values({
				id: "att-good",
				message_id: goodMessageId,
				filename: "receipt.pdf",
				mime_type: "application/pdf",
				size_bytes: 42,
				content_id: null,
				is_inline: 0,
			})
			.execute();

		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");

		const jobId = await jobs.queueJob({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});
		await worker.runWorkerIteration({ waitOnIdle: false });

		const backlogJob = await db
			.selectFrom("jobs")
			.select(["status", "error_count"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		expect(backlogJob).toEqual({
			status: "complete",
			error_count: 1,
		});

		const label = await db
			.selectFrom("message_labels")
			.select(["message_id", "primary_bucket"])
			.where("message_id", "=", goodMessageId)
			.executeTakeFirstOrThrow();
		expect(label).toEqual({
			message_id: goodMessageId,
			primary_bucket: "finance",
		});
		const failedLabel = await db
			.selectFrom("message_labels")
			.select(["message_id"])
			.where("message_id", "=", badMessageId)
			.executeTakeFirst();
		expect(failedLabel).toBeUndefined();

		const rows = await db
			.selectFrom("jobs")
			.select(["kind"])
			.where("scope_id", "=", "acct-1")
			.orderBy("created_at")
			.execute();
		expect(rows.some((row) => row.kind === "rebuild_overseer")).toBe(true);
		expect(buildOverseerProfile).not.toHaveBeenCalled();
	});
});
