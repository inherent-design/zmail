import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertMessageLabelRow,
	insertMessageRow,
	insertSecondaryResultRow,
	seedTestAccount,
} from "#/test/helpers/db";
import {
	buildFinanceIntelV3,
	buildMessageLabelV3,
} from "#/test/helpers/labels";
import { createTestRuntime } from "#/test/helpers/runtime";

function financeLabel() {
	return buildMessageLabelV3({
		finance: {
			relevant: true,
			signal: "receipt",
			operational: true,
			bookHint: "business",
			requiresFinanceIntel: true,
			confidence: 0.95,
			evidence: "Software receipt.",
		},
		commerce: { transactional: true },
		routing: {
			primaryBucket: "finance",
			secondaryBuckets: ["receipt"],
			tags: ["receipt"],
		},
	});
}

describe("worker finance jobs", () => {
	it("imports the operator registry and queues finance backlogs per account", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		await seedTestAccount(dbModule.getDb(), { id: "acct-1", label: "One" });
		await seedTestAccount(dbModule.getDb(), { id: "acct-2", label: "Two" });

		vi.doMock("#/lib/registry", () => ({
			importOperatorRegistry: vi.fn(async () => ({
				counts: {
					identities: 1,
					institutions: 1,
					financialAccounts: 1,
					senderRules: 1,
				},
				importedAt: "2026-01-10T00:00:00.000Z",
				sha256: "registry-sha",
				sourceDir: "/tmp/registry",
			})),
		}));

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobId = await jobs.queueJobIdempotent({
			kind: "import_operator_registry",
			scopeType: "system",
			scopeId: "operator_registry",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const db = dbModule.getDb();
		const importJob = await db
			.selectFrom("jobs")
			.select(["status", "success_count", "error_count", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		const financeBacklogs = await db
			.selectFrom("jobs")
			.select(["kind", "scope_type", "scope_id", "status"])
			.where("kind", "=", "classify_finance_backlog")
			.orderBy("scope_id")
			.execute();

		expect(importJob.status).toBe("complete");
		expect(importJob.success_count).toBe(4);
		expect(importJob.error_count).toBe(0);
		expect(JSON.parse(importJob.meta_json ?? "{}")).toMatchObject({
			queuedFinanceBacklogs: 2,
			registrySha256: "registry-sha",
		});
		expect(financeBacklogs).toEqual([
			{
				kind: "classify_finance_backlog",
				scope_type: "account",
				scope_id: "acct-1",
				status: "queued",
			},
			{
				kind: "classify_finance_backlog",
				scope_type: "account",
				scope_id: "acct-2",
				status: "queued",
			},
		]);
	});

	it("rebuilds finance knowledge through the worker job", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });

		vi.doMock("#/lib/finance-knowledge", () => ({
			rebuildFinanceKnowledge: vi.fn(async () => ({
				events: 2,
				documents: 1,
				evidence: 3,
			})),
		}));

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const jobId = await jobs.queueJobIdempotent({
			kind: "rebuild_finance_knowledge",
			scopeType: "system",
			scopeId: "finance",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const row = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["status", "success_count", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		expect(row.status).toBe("complete");
		expect(row.success_count).toBe(3);
		expect(JSON.parse(row.meta_json ?? "{}")).toMatchObject({
			events: 2,
			documents: 1,
			evidence: 3,
		});
	});

	it("completes finance backlog jobs immediately when no finance root labels exist", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "msg-no-finance",
			accountId: "acct-1",
			contentSha256: "content-no-finance",
		});
		await insertMessageLabelRow(db, {
			messageId,
			contentSha256: "content-no-finance",
		});

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobId = await jobs.queueJobIdempotent({
			kind: "classify_finance_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const row = await db
			.selectFrom("jobs")
			.select(["status", "success_count", "error_count", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		expect(row.status).toBe("complete");
		expect(row.success_count).toBe(0);
		expect(row.error_count).toBe(0);
		expect(JSON.parse(row.meta_json ?? "{}")).toMatchObject({
			mode: "live",
			processed: 0,
			total: 0,
		});
	});

	it("skips current heads and blocks parse errors while classifying stale finance rows", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const currentMessageId = await insertMessageRow(db, {
			id: "msg-current-finance",
			accountId: "acct-1",
			contentSha256: "content-current",
		});
		const parseErrorMessageId = await insertMessageRow(db, {
			id: "msg-parse-error-finance",
			accountId: "acct-1",
			parseStatus: "error",
			parseErrorReason: "html parse failed",
			contentSha256: "content-parse-error",
		});
		const staleMessageId = await insertMessageRow(db, {
			id: "msg-stale-finance",
			accountId: "acct-1",
			senderAddress: null,
			subject: null,
			receivedAt: null,
			contentSha256: "content-stale",
		});
		for (const id of [currentMessageId, parseErrorMessageId, staleMessageId]) {
			await insertMessageLabelRow(db, {
				messageId: id,
				primaryBucket: "finance",
				contentSha256:
					id === currentMessageId
						? "content-current"
						: id === parseErrorMessageId
							? "content-parse-error"
							: "content-stale",
				label: financeLabel(),
			});
		}
		await insertSecondaryResultRow(db, {
			messageId: currentMessageId,
			status: "ready",
			contentSha256: "content-current",
			registrySha256: "registry-sha",
			result: buildFinanceIntelV3(),
		});

		const classifyFinanceMessageNow = vi.fn(
			async (input: { messageId: string }) => {
				const { getDb } = await import("#/lib/db");
				const { nowIso } = await import("#/lib/config");
				const liveDb = getDb();
				await liveDb
					.insertInto("message_secondary_results")
					.values({
						id: `secondary-${input.messageId}`,
						message_id: input.messageId,
						classifier_key: "finance_intel",
						schema_version: "finance-intel.v3",
						job_id: null,
						model: "gpt-5.4-mini",
						prompt_version: "finance-intel-v3",
						source: "model",
						result_json: JSON.stringify(buildFinanceIntelV3()),
						raw_response_json: "{}",
						usage_json: null,
						input_content_sha256: "content-stale",
						input_registry_sha256: "registry-sha",
						created_at: nowIso(),
					})
					.execute();
				await liveDb
					.insertInto("message_secondary_heads")
					.values({
						message_id: input.messageId,
						classifier_key: "finance_intel",
						secondary_result_id: `secondary-${input.messageId}`,
						status: "ready",
						low_confidence: 0,
						content_sha256: "content-stale",
						registry_sha256: "registry-sha",
						updated_at: nowIso(),
					})
					.onConflict((oc) =>
						oc.columns(["message_id", "classifier_key"]).doUpdateSet({
							secondary_result_id: `secondary-${input.messageId}`,
							status: "ready",
							low_confidence: 0,
							content_sha256: "content-stale",
							registry_sha256: "registry-sha",
							updated_at: nowIso(),
						}),
					)
					.execute();
				return {
					headStatus: "ready" as const,
					lowConfidence: false,
					financeIntel: { schemaVersion: "finance-intel.v3" },
					model: "gpt-5.4-mini",
					backend: "openai-subscription",
					usage: null,
				};
			},
		);

		vi.doMock("#/lib/registry", () => ({
			loadOperatorRegistry: vi.fn(async () => ({
				sha256: "registry-sha",
				importedAt: "2026-01-10T00:00:00.000Z",
				sourceDir: "/tmp/registry",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
			matchRegistryForMessage: vi.fn(async () => ({
				sha256: "registry-sha",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
		}));
		vi.doMock("#/lib/finance-intel", () => ({
			classifyFinanceMessageNow,
		}));

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobId = await jobs.queueJobIdempotent({
			kind: "classify_finance_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const backlogJob = await db
			.selectFrom("jobs")
			.select(["status", "success_count", "error_count", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		const parseErrorHead = await db
			.selectFrom("message_secondary_heads")
			.select(["status", "content_sha256", "registry_sha256"])
			.where("message_id", "=", parseErrorMessageId)
			.executeTakeFirstOrThrow();
		const staleHead = await db
			.selectFrom("message_secondary_heads")
			.select(["status", "content_sha256", "registry_sha256"])
			.where("message_id", "=", staleMessageId)
			.executeTakeFirstOrThrow();
		const queuedKnowledgeJob = await db
			.selectFrom("jobs")
			.select(["kind", "status", "scope_id"])
			.where("kind", "=", "rebuild_finance_knowledge")
			.executeTakeFirstOrThrow();

		expect(classifyFinanceMessageNow).toHaveBeenCalledOnce();
		expect(backlogJob.status).toBe("complete");
		expect(backlogJob.success_count).toBe(2);
		expect(backlogJob.error_count).toBe(0);
		expect(JSON.parse(backlogJob.meta_json ?? "{}")).toMatchObject({
			mode: "live",
			processed: 2,
			total: 2,
			registrySha256: "registry-sha",
		});
		expect(parseErrorHead).toEqual({
			status: "blocked_parse_error",
			content_sha256: "content-parse-error",
			registry_sha256: "registry-sha",
		});
		expect(staleHead).toEqual({
			status: "ready",
			content_sha256: "content-stale",
			registry_sha256: "registry-sha",
		});
		expect(queuedKnowledgeJob).toEqual({
			kind: "rebuild_finance_knowledge",
			status: "queued",
			scope_id: "finance",
		});
	});

	it("counts blocked model-output finance rows as persisted successes", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "msg-blocked-model-output",
			accountId: "acct-1",
			contentSha256: "content-blocked-model",
		});
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "content-blocked-model",
			label: financeLabel(),
		});

		const blockedFinanceIntel = buildFinanceIntelV3({
			actionability: "manual_review",
			book: {
				scope: "business",
				businessUsePercent: null,
				taxTreatmentHint: null,
				evidence: "Software receipt.",
			},
			ledgerReadiness: {
				status: "blocked",
				reasons: ["model_output_invalid"],
				requiredFixes: ["manualReview"],
			},
			transactionCandidates: [],
			documentCandidates: [],
			dedupe: {
				messageEvidenceKey: "email:msg-blocked-model-output",
				sourceDocumentRefs: [],
				externalTransactionIds: [],
				normalizedComposites: [],
			},
			fieldConfidence: {
				amount: null,
				date: null,
				counterparty: null,
				accountMapping: null,
				book: null,
				category: null,
				dedupe: null,
			},
			confidence: {
				overall: 0,
				messageKind: 0,
				transactionExtraction: 0,
				registryMatching: 0,
			},
			explanation: "Blocked because model output did not satisfy v3.",
		});

		const classifyFinanceMessageNow = vi.fn(
			async (input: { jobId?: string | null; messageId: string }) => {
				const { persistSecondaryResult } = await import("#/lib/secondary");
				await persistSecondaryResult({
					jobId: input.jobId ?? null,
					messageId: input.messageId,
					classifierKey: "finance_intel",
					schemaVersion: "finance-intel.v3",
					model: "gpt-5.4-mini",
					backend: "openai-subscription",
					promptVersion: "finance-intel-v3",
					source: "model",
					rawResponse: { parseError: "fixture parse error" },
					usage: null,
					result: blockedFinanceIntel,
					contentSha256: "content-blocked-model",
					registrySha256: "registry-sha",
					status: "review",
					overallConfidence: 0,
				});
				return {
					headStatus: "review" as const,
					lowConfidence: true,
					financeIntel: blockedFinanceIntel,
					model: "gpt-5.4-mini",
					backend: "openai-subscription",
					usage: null,
					blockedModelOutput: true,
				};
			},
		);

		vi.doMock("#/lib/registry", () => ({
			loadOperatorRegistry: vi.fn(async () => ({
				sha256: "registry-sha",
				importedAt: "2026-01-10T00:00:00.000Z",
				sourceDir: "/tmp/registry",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
			matchRegistryForMessage: vi.fn(async () => ({
				sha256: "registry-sha",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
		}));
		vi.doMock("#/lib/finance-intel", () => ({
			classifyFinanceMessageNow,
		}));

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobId = await jobs.queueJobIdempotent({
			kind: "classify_finance_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const backlogJob = await db
			.selectFrom("jobs")
			.select(["status", "success_count", "error_count", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		const head = await db
			.selectFrom("message_secondary_heads")
			.select(["status", "content_sha256", "registry_sha256"])
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();
		const queuedKnowledgeJob = await db
			.selectFrom("jobs")
			.select(["kind", "status", "scope_id"])
			.where("kind", "=", "rebuild_finance_knowledge")
			.executeTakeFirstOrThrow();

		expect(backlogJob.status).toBe("complete");
		expect(backlogJob.success_count).toBe(1);
		expect(backlogJob.error_count).toBe(0);
		expect(JSON.parse(backlogJob.meta_json ?? "{}")).toMatchObject({
			mode: "live",
			processed: 1,
			total: 1,
			registrySha256: "registry-sha",
			blockedModelOutputCount: 1,
		});
		expect(head).toEqual({
			status: "review",
			content_sha256: "content-blocked-model",
			registry_sha256: "registry-sha",
		});
		expect(queuedKnowledgeJob).toEqual({
			kind: "rebuild_finance_knowledge",
			status: "queued",
			scope_id: "finance",
		});
	});

	it("fails finance backlog jobs when persistence/classifier errors occur", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "msg-finance-infra-error",
			accountId: "acct-1",
			contentSha256: "content-infra-error",
		});
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "content-infra-error",
			label: financeLabel(),
		});

		vi.doMock("#/lib/registry", () => ({
			loadOperatorRegistry: vi.fn(async () => ({
				sha256: "registry-sha",
				importedAt: "2026-01-10T00:00:00.000Z",
				sourceDir: "/tmp/registry",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
			matchRegistryForMessage: vi.fn(async () => ({
				sha256: "registry-sha",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
		}));
		vi.doMock("#/lib/finance-intel", () => ({
			classifyFinanceMessageNow: vi.fn(async () => {
				throw new Error("fixture persistence failure");
			}),
		}));

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobId = await jobs.queueJobIdempotent({
			kind: "classify_finance_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const backlogJob = await db
			.selectFrom("jobs")
			.select([
				"status",
				"success_count",
				"error_count",
				"last_error",
				"meta_json",
			])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		const rebuildCount = await db
			.selectFrom("jobs")
			.select(({ fn }) => fn.countAll<number>().as("count"))
			.where("kind", "=", "rebuild_finance_knowledge")
			.executeTakeFirstOrThrow();

		expect(backlogJob.status).toBe("failed");
		expect(backlogJob.success_count).toBe(0);
		expect(backlogJob.error_count).toBe(1);
		expect(backlogJob.last_error).toContain("Finance backlog failed 1 of 1");
		expect(JSON.parse(backlogJob.meta_json ?? "{}")).toMatchObject({
			mode: "live",
			processed: 1,
			total: 1,
			registrySha256: "registry-sha",
			blockedModelOutputCount: 0,
		});
		expect(Number(rebuildCount.count)).toBe(0);
	});

	it("completes finance backlog jobs when all finance heads are current", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const parsedMessageId = await insertMessageRow(db, {
			id: "msg-current-ready-finance",
			accountId: "acct-1",
			contentSha256: "content-ready",
		});
		const parseErrorMessageId = await insertMessageRow(db, {
			id: "msg-current-blocked-finance",
			accountId: "acct-1",
			parseStatus: "error",
			parseErrorReason: "parse failed",
			contentSha256: "content-blocked",
		});
		for (const [messageId, contentSha256] of [
			[parsedMessageId, "content-ready"],
			[parseErrorMessageId, "content-blocked"],
		] as const) {
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket: "finance",
				contentSha256,
				label: financeLabel(),
			});
		}
		await insertSecondaryResultRow(db, {
			messageId: parsedMessageId,
			status: "ready",
			contentSha256: "content-ready",
			registrySha256: "registry-sha",
			result: buildFinanceIntelV3(),
		});
		await insertSecondaryResultRow(db, {
			messageId: parseErrorMessageId,
			status: "blocked_parse_error",
			contentSha256: "content-blocked",
			registrySha256: "registry-sha",
			result: buildFinanceIntelV3(),
		});

		vi.doMock("#/lib/registry", () => ({
			loadOperatorRegistry: vi.fn(async () => ({
				sha256: "registry-sha",
				importedAt: "2026-01-10T00:00:00.000Z",
				sourceDir: "/tmp/registry",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
			})),
			matchRegistryForMessage: vi.fn(),
		}));
		vi.doMock("#/lib/finance-intel", () => ({
			classifyFinanceMessageNow: vi.fn(),
		}));

		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const jobId = await jobs.queueJobIdempotent({
			kind: "classify_finance_backlog",
			scopeType: "account",
			scopeId: "acct-1",
		});

		expect(await worker.runWorkerIteration({ waitOnIdle: false })).toBe(true);

		const row = await db
			.selectFrom("jobs")
			.select(["status", "success_count", "error_count", "meta_json"])
			.where("id", "=", jobId)
			.executeTakeFirstOrThrow();
		expect(row.status).toBe("complete");
		expect(row.success_count).toBe(0);
		expect(row.error_count).toBe(0);
		expect(JSON.parse(row.meta_json ?? "{}")).toMatchObject({
			mode: "live",
			processed: 0,
			total: 0,
			registrySha256: "registry-sha",
		});
	});
});
