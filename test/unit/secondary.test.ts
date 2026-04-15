import { describe, expect, it } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("secondary", () => {
	it("resolves head status from explicit values and confidence", async () => {
		const runtime = await createTestRuntime();
		const secondary =
			await runtime.importFresh<typeof import("#/lib/secondary")>(
				"#/lib/secondary",
			);

		expect(
			secondary.resolveSecondaryHeadStatus({
				status: "blocked_parse_error",
				overallConfidence: 0.1,
			}),
		).toBe("blocked_parse_error");
		expect(
			secondary.resolveSecondaryHeadStatus({
				overallConfidence: 0.5,
			}),
		).toBe("review");
		expect(
			secondary.resolveSecondaryHeadStatus({
				overallConfidence: 0.95,
			}),
		).toBe("ready");
		expect(secondary.isLowConfidenceScore(0.5)).toBe(true);
		expect(secondary.isLowConfidenceScore(0.95)).toBe(false);
	});

	it("persists secondary results and maintains heads", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "msg-secondary-1",
			accountId: "acct-1",
			contentSha256: "message-sha-1",
		});
		const messageIdExplicit = await insertMessageRow(db, {
			id: "msg-secondary-2",
			accountId: "acct-1",
			contentSha256: "message-sha-2",
		});
		const secondary =
			await runtime.importFresh<typeof import("#/lib/secondary")>(
				"#/lib/secondary",
			);

		const persisted = await secondary.persistSecondaryResult({
			jobId: null,
			messageId,
			classifierKey: "finance_intel",
			schemaVersion: "finance-intel.v1",
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "finance-intel-v1",
			source: "model",
			rawResponse: { ok: true },
			usage: { totalTokens: 12 },
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [],
				documentCandidates: [],
				matchedRegistryRefs: {
					identityIds: [],
					institutionIds: [],
					financialAccountIds: [],
				},
				unresolvedEntityHints: {
					identityHints: [],
					institutionHints: [],
					financialAccountHints: [],
				},
				confidence: {
					overall: 0.6,
					messageKind: 0.9,
					transactionExtraction: 0.9,
					registryMatching: 0.9,
				},
				explanation: "needs review",
			},
			registrySha256: "registry-sha-1",
			overallConfidence: 0.6,
		});

		const explicit = await secondary.persistSecondaryResult({
			jobId: null,
			messageId: messageIdExplicit,
			classifierKey: "finance_intel",
			schemaVersion: "finance-intel.v1",
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "finance-intel-v1",
			source: "manual",
			rawResponse: { ok: true },
			usage: null,
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "statement",
				actionability: "capture_document",
				transactionCandidates: [],
				documentCandidates: [],
				matchedRegistryRefs: {
					identityIds: [],
					institutionIds: [],
					financialAccountIds: [],
				},
				unresolvedEntityHints: {
					identityHints: [],
					institutionHints: [],
					financialAccountHints: [],
				},
				confidence: {
					overall: 0.95,
					messageKind: 0.95,
					transactionExtraction: 0.95,
					registryMatching: 0.95,
				},
				explanation: "ready",
			},
			contentSha256: "explicit-content-sha",
			registrySha256: null,
			status: "ready",
			overallConfidence: null,
		});

		const resultRows = await db
			.selectFrom("message_secondary_results")
			.select([
				"id",
				"message_id",
				"source",
				"usage_json",
				"input_content_sha256",
				"input_registry_sha256",
			])
			.orderBy("message_id")
			.execute();
		const firstHead = await db
			.selectFrom("message_secondary_heads")
			.selectAll()
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();

		expect(persisted.lowConfidence).toBe(true);
		expect(persisted.status).toBe("review");
		expect(explicit.lowConfidence).toBe(false);
		expect(explicit.status).toBe("ready");
		expect(resultRows).toEqual([
			expect.objectContaining({
				id: persisted.resultId,
				message_id: messageId,
				source: "model",
				input_content_sha256: "message-sha-1",
				input_registry_sha256: "registry-sha-1",
			}),
			expect.objectContaining({
				id: explicit.resultId,
				message_id: messageIdExplicit,
				source: "manual",
				usage_json: null,
				input_content_sha256: "explicit-content-sha",
				input_registry_sha256: null,
			}),
		]);
		expect(firstHead.status).toBe("review");
		expect(firstHead.low_confidence).toBe(1);
		expect(
			secondary.isSecondaryHeadCurrent(firstHead, {
				contentSha256: "message-sha-1",
				registrySha256: "registry-sha-1",
			}),
		).toBe(true);
		expect(
			secondary.isSecondaryHeadCurrent(firstHead, {
				contentSha256: "other-sha",
				registrySha256: "registry-sha-1",
			}),
		).toBe(false);
		expect(
			secondary.isSecondaryHeadCurrent(null, {
				contentSha256: "message-sha-1",
				registrySha256: "registry-sha-1",
			}),
		).toBe(false);

		await secondary.upsertSecondaryHead({
			messageId,
			classifierKey: "finance_intel",
			secondaryResultId: null,
			status: "ready",
			lowConfidence: false,
			contentSha256: "message-sha-updated",
			registrySha256: "registry-sha-updated",
		});
		await secondary.markSecondaryHeadStale({
			messageId,
			classifierKey: "finance_intel",
		});

		const updatedHead = await db
			.selectFrom("message_secondary_heads")
			.selectAll()
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();
		expect(updatedHead.secondary_result_id).toBeNull();
		expect(updatedHead.status).toBe("stale");
		expect(updatedHead.low_confidence).toBe(0);
		expect(updatedHead.content_sha256).toBe("message-sha-updated");
		expect(updatedHead.registry_sha256).toBe("registry-sha-updated");
		expect(
			secondary.isSecondaryHeadCurrent(updatedHead, {
				contentSha256: "message-sha-updated",
				registrySha256: "registry-sha-updated",
			}),
		).toBe(false);
	});
});
