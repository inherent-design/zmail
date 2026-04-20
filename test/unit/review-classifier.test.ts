import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertMessageLabelRow,
	insertMessageRow,
	insertReviewRow,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("review classifier", () => {
	it("persists findings and dispatches targeted follow-up jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "message-review-target",
			accountId: "acct-1",
			bodyTextNormalized: "Example receipt",
			contentSha256: "content-review",
		});
		await insertMessageLabelRow(db, {
			messageId,
			contentSha256: "content-review",
			lowConfidence: 1,
		});
		await insertReviewRow(db, {
			id: "review-target",
			messageId,
			sourceClassificationResultId: `classification-${messageId}`,
		});
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-target",
				canonical_key: "ledger-target",
				status: "review",
				source_authority: "email",
				occurred_at: "2025-01-15",
				posted_at: null,
				cleared_at: null,
				description: "Needs finance recheck",
				counterparty: "Example",
				direction: "expense",
				amount_value: "25.00",
				amount_minor: 2500,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: null,
				credit_account: null,
				account_mapping_key: null,
				field_confidence_json: "{}",
				ledger_metadata_json: "{}",
				raw_payload_json: "{}",
				created_at: "2025-01-15T00:00:00.000Z",
				updated_at: "2025-01-15T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values({
				id: "ledger-source-target",
				ledger_entry_id: "ledger-target",
				source_kind: "email",
				message_id: messageId,
				secondary_result_id: null,
				import_run_id: null,
				import_transaction_id: null,
				import_document_id: null,
				evidence_json: "{}",
				created_at: "2025-01-15T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/pi", () => ({
			piJson: vi.fn(async () => ({
				backend: "openai",
				modelId: "gpt-5.4-mini",
				rawText: "{}",
				usage: null,
				parsed: {
					schemaVersion: "review-classifier.v1",
					summary: "Root and finance issues found.",
					findings: [
						{
							targetKind: "root_review",
							targetId: "review-target",
							severity: "high",
							action: "enqueue_root_reclassify",
							confidence: 0.91,
							reason: "Root label looks stale.",
							evidenceRefs: ["review:review-target"],
						},
						{
							targetKind: "finance_ledger_entry",
							targetId: "ledger-target",
							severity: "medium",
							action: "mapping_needed",
							confidence: 0.86,
							reason: "Missing mapping.",
							evidenceRefs: ["ledger:ledger-target"],
						},
						{
							targetKind: "finance_ledger_entry",
							targetId: "missing-ledger",
							severity: "critical",
							action: "needs_manual_review",
							confidence: 1,
							reason: "Invalid target should be filtered.",
							evidenceRefs: [],
						},
					],
					targetedReclassification: [
						{
							classifier: "finance",
							messageIds: [messageId],
							reason: "Finance extraction needs rerun.",
						},
					],
					mappingSuggestionRefs: [],
					overseerSignals: ["Sender should be remembered."],
				},
			})),
		}));

		const { runReviewClassifier } = await runtime.importFresh<
			typeof import("#/lib/review-classifier")
		>("#/lib/review-classifier");
		const result = await runReviewClassifier();

		expect(result.result.findings).toHaveLength(2);
		const heads = await db
			.selectFrom("review_classification_heads")
			.select(["target_kind", "target_id", "action"])
			.orderBy("target_kind")
			.execute();
		expect(heads).toEqual([
			{
				target_kind: "finance_ledger_entry",
				target_id: "ledger-target",
				action: "mapping_needed",
			},
			{
				target_kind: "root_review",
				target_id: "review-target",
				action: "enqueue_root_reclassify",
			},
		]);
		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "scope_id", "meta_json"])
			.orderBy("kind")
			.execute();
		expect(jobs.map((job) => job.kind)).toEqual([
			"classify_finance_messages",
			"classify_root_messages",
			"rebuild_overseer",
		]);
		expect(jobs.map((job) => JSON.parse(job.meta_json ?? "{}"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetMessageIds: [messageId],
					reviewClassificationResultId: result.resultId,
				}),
				expect.objectContaining({
					reviewClassificationResultId: result.resultId,
				}),
			]),
		);
		expect(
			await db.selectFrom("registry_suggestions").selectAll().execute(),
		).toHaveLength(1);
	});
});
