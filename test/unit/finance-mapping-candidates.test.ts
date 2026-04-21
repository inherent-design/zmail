import { describe, expect, it } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

function ledgerRow(id: string, canonicalKey = `canonical:${id}`) {
	return {
		id,
		canonical_key: canonicalKey,
		status: "review",
		source_authority: "email",
		occurred_at: "2025-03-01",
		posted_at: null,
		cleared_at: null,
		description: "GitHub monthly subscription",
		counterparty: "GitHub",
		direction: "expense",
		amount_value: "10.00",
		amount_minor: 1000,
		currency: "USD",
		book: "business",
		business_use_percent: null,
		debit_account: null,
		credit_account: null,
		account_mapping_key: null,
		field_confidence_json: "{}",
		ledger_metadata_json: JSON.stringify({
			categoryPrimary: "software_services",
			categorySecondary: "hosting",
		}),
		raw_payload_json: "{}",
		created_at: "2025-03-01T00:00:00.000Z",
		updated_at: "2025-03-01T00:00:00.000Z",
	};
}

describe("finance mapping candidates", () => {
	it("clusters missing mappings into one high-confidence suggestion", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("review_classification_results")
			.values({
				id: "review-result-mapping-candidates",
				job_id: null,
				schema_version: "review-classifier.v1",
				model: "test",
				prompt_version: "review-classifier-v1",
				prompt_sha256: null,
				source: "model",
				input_summary_json: "{}",
				result_json: "{}",
				raw_response_json: "{}",
				usage_json: null,
				created_at: "2025-03-01T00:00:00.000Z",
			})
			.execute();
		const messageId = await insertMessageRow(db, {
			id: "msg-mapping-candidate",
			accountId: "acct-1",
			senderAddress: "billing@github.com",
			subject: "GitHub receipt",
			contentSha256: "content-mapping-candidate",
		});
		await db
			.insertInto("finance_ledger_entries")
			.values([
				ledgerRow("ledger-map-1"),
				ledgerRow("ledger-map-2"),
				ledgerRow("ledger-map-3"),
			])
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values([
				{
					id: "source-map-1",
					ledger_entry_id: "ledger-map-1",
					source_kind: "email",
					message_id: messageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: "{}",
					created_at: "2025-03-01T00:00:00.000Z",
				},
				{
					id: "source-map-2",
					ledger_entry_id: "ledger-map-2",
					source_kind: "email",
					message_id: messageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: "{}",
					created_at: "2025-03-01T00:00:00.000Z",
				},
				{
					id: "source-map-3",
					ledger_entry_id: "ledger-map-3",
					source_kind: "email",
					message_id: messageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: "{}",
					created_at: "2025-03-01T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("review_classification_heads")
			.values([
				{
					target_kind: "finance_ledger_entry",
					target_id: "ledger-map-1",
					result_id: "review-result-mapping-candidates",
					severity: "high",
					action: "mapping_needed",
					status: "open",
					confidence: 0.96,
					reason: "needs mapping",
					evidence_refs_json: "[]",
					updated_at: "2025-03-01T00:00:00.000Z",
				},
			])
			.execute();

		const candidates = await runtime.importFresh<
			typeof import("#/lib/finance-mapping-candidates")
		>("#/lib/finance-mapping-candidates");
		const result = await candidates.generateFinanceMappingCandidates({
			year: 2025,
		});

		expect(result).toMatchObject({
			ledgerRows: 3,
			clusters: 1,
			mappingSuggestions: 1,
		});
		const suggestions = await db
			.selectFrom("registry_suggestions")
			.selectAll()
			.orderBy("entity_kind", "asc")
			.execute();
		const mapping = suggestions.find(
			(row) => row.entity_kind === "finance_account_mapping",
		);
		expect(mapping?.confidence).toBeGreaterThanOrEqual(0.95);
		expect(JSON.parse(mapping?.suggestion_json ?? "{}")).toMatchObject({
			schemaVersion: "finance-account-mapping-suggestion.v1",
			impact: {
				ledgerEntryIds: ["ledger-map-1", "ledger-map-2", "ledger-map-3"],
				ledgerCanonicalKeys: [
					"canonical:ledger-map-1",
					"canonical:ledger-map-2",
					"canonical:ledger-map-3",
				],
				rowCount: 3,
				readyUnlockEstimate: 3,
			},
			evidence: {
				senderDomains: ["github.com"],
			},
			autoApplyEligible: true,
		});
		expect(suggestions.some((row) => row.entity_kind === "sender_rule")).toBe(
			true,
		);

		await candidates.generateFinanceMappingCandidates({ year: 2025 });
		const afterSecondRun = await db
			.selectFrom("registry_suggestions")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(Number(afterSecondRun.count)).toBe(suggestions.length);

		await db.deleteFrom("finance_ledger_entry_sources").execute();
		await db.deleteFrom("finance_ledger_entries").execute();
		await db
			.insertInto("finance_ledger_entries")
			.values([
				ledgerRow("ledger-map-next-1", "canonical:ledger-map-1"),
				ledgerRow("ledger-map-next-2", "canonical:ledger-map-2"),
				ledgerRow("ledger-map-next-3", "canonical:ledger-map-3"),
			])
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values([
				{
					id: "source-map-next-1",
					ledger_entry_id: "ledger-map-next-1",
					source_kind: "email",
					message_id: messageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: "{}",
					created_at: "2025-03-01T00:00:00.000Z",
				},
				{
					id: "source-map-next-2",
					ledger_entry_id: "ledger-map-next-2",
					source_kind: "email",
					message_id: messageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: "{}",
					created_at: "2025-03-01T00:00:00.000Z",
				},
				{
					id: "source-map-next-3",
					ledger_entry_id: "ledger-map-next-3",
					source_kind: "email",
					message_id: messageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: "{}",
					created_at: "2025-03-01T00:00:00.000Z",
				},
			])
			.execute();

		await candidates.generateFinanceMappingCandidates({ year: 2025 });
		const afterSnapshotRun = await db
			.selectFrom("registry_suggestions")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(Number(afterSnapshotRun.count)).toBe(suggestions.length);
	});

	it("skips low-confidence diagnostic clusters", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values({
				...ledgerRow("ledger-low-confidence"),
				counterparty: null,
				ledger_metadata_json: JSON.stringify({
					categoryPrimary: "uncategorized",
				}),
			})
			.execute();

		const candidates = await runtime.importFresh<
			typeof import("#/lib/finance-mapping-candidates")
		>("#/lib/finance-mapping-candidates");
		const result = await candidates.generateFinanceMappingCandidates({
			year: 2025,
		});

		expect(result.suggestions).toBe(0);
		expect(result.skippedLowConfidence).toBe(1);
	});
});
