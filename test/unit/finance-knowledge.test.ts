import { describe, expect, it } from "vitest";
import { buildFinanceRollupView } from "#/lib/finance-rollups";
import {
	bootDb,
	insertMessageLabelRow,
	insertMessageRow,
	insertMessageSourceRow,
	insertSecondaryResultRow,
} from "#/test/helpers/db";
import {
	buildFinanceIntelV3,
	buildMessageLabelV3,
} from "#/test/helpers/labels";
import { createTestRuntime } from "#/test/helpers/runtime";

type TestDb = Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>;

async function seedMapping(db: TestDb, input?: { mappingKey?: string }) {
	await db
		.insertInto("finance_account_mappings")
		.values({
			id: `mapping-${input?.mappingKey ?? "bank-checking"}`,
			mapping_key: input?.mappingKey ?? "bank:checking",
			book: "business",
			account_name: "Assets:Business:Bank:Checking",
			account_type: "posting",
			currency: "USD",
			confidence: 0.95,
			source_json: JSON.stringify({ fixture: true }),
			debit_account: "Expenses:Business:Software",
			credit_account: "Assets:Business:Bank:Checking",
			match_json: JSON.stringify({ counterpartyIncludes: "example" }),
			notes: null,
			source_path: "operator/registry/finance-account-mappings.yaml",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		})
		.execute();
}

async function seedFinanceMessage(
	db: TestDb,
	input?: {
		messageId?: string;
		receivedAt?: string;
		result?: ReturnType<typeof buildFinanceIntelV3>;
	},
) {
	const messageId = await insertMessageRow(db, {
		id: input?.messageId,
		accountId: "acct-1",
		receivedAt: input?.receivedAt ?? "2026-01-02T00:00:00.000Z",
		contentSha256: `${input?.messageId ?? "message"}-sha`,
	});
	await insertMessageLabelRow(db, {
		messageId,
		primaryBucket: "finance",
		contentSha256: `${input?.messageId ?? "message"}-sha`,
		label: buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "receipt",
				operational: true,
				bookHint: "business",
				requiresFinanceIntel: true,
				confidence: 0.95,
				evidence: "Receipt evidence.",
			},
			commerce: { transactional: true },
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["receipt"],
				tags: ["receipt"],
			},
		}),
	});
	await insertSecondaryResultRow(db, {
		messageId,
		contentSha256: `${input?.messageId ?? "message"}-sha`,
		registrySha256: "registry-sha",
		result: input?.result ?? buildFinanceIntelV3(),
	});
	return messageId;
}

describe("finance knowledge", () => {
	it("stages ready ledger entries and sources from finance-intel.v3 heads", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		await seedFinanceMessage(db, {
			messageId: "message-finance-ready",
			result: buildFinanceIntelV3({
				transactionCandidates: [
					{
						merchantOrCounterparty: "Example SaaS",
						amount: "42.00",
						occurredAt: "2026-01-02",
						dedupe: {
							normalizedComposite:
								"business|acct|2026-01-02|42|usd|example-saas",
						},
					},
				],
			}),
		});

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();

		const entries = await db
			.selectFrom("finance_ledger_entries")
			.selectAll()
			.execute();
		const sources = await db
			.selectFrom("finance_ledger_entry_sources")
			.selectAll()
			.execute();

		expect(result).toMatchObject({
			entries: 1,
			ready: 1,
			review: 0,
			blocked: 0,
			evidence: 1,
		});
		expect(entries[0]).toMatchObject({
			status: "ready",
			source_authority: "email",
			counterparty: "Example SaaS",
			debit_account: "Expenses:Business:Software",
			credit_account: "Assets:Business:Bank:Checking",
		});
		expect(sources[0]).toMatchObject({
			source_kind: "email",
			message_id: "message-finance-ready",
		});
	});

	it("recovers exact posted_at from message timestamps for partial email dates", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		const messageId = await seedFinanceMessage(db, {
			messageId: "message-finance-partial-date",
			receivedAt: "2026-02-01T06:45:35.000Z",
			result: buildFinanceIntelV3({
				transactionCandidates: [
					{
						merchantOrCounterparty: "DigitalOcean",
						amount: "42.00",
						occurredAt: "2026-01",
						postedAt: null,
						clearedAt: null,
						dedupe: {
							normalizedComposite: null,
							emailEvidenceKey: "email:message-finance-partial-date",
						},
					},
				],
			}),
		});
		await insertMessageSourceRow(db, {
			messageId,
			accountId: "acct-1",
			remoteMessageId: "remote-partial-date",
			remoteThreadId: "thread-partial-date",
			rawRfc822Path: null,
		});

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const first = await financeKnowledge.rebuildFinanceKnowledge();
		const firstEntry = await db
			.selectFrom("finance_ledger_entries")
			.select([
				"status",
				"canonical_key",
				"occurred_at",
				"occurred_at_precision",
				"posted_at",
				"posted_at_precision",
				"ledger_metadata_json",
			])
			.executeTakeFirstOrThrow();
		const firstMetadata = JSON.parse(firstEntry.ledger_metadata_json) as Record<
			string,
			unknown
		>;

		expect(first).toMatchObject({ ready: 1, review: 0 });
		expect(firstEntry).toMatchObject({
			status: "ready",
			canonical_key:
				"composite:business|acct:checking|2026-02-01|42-00|USD|digitalocean",
			occurred_at: "2026-01",
			occurred_at_precision: "month",
			posted_at: "2026-02-01T06:45:35.000Z",
			posted_at_precision: "datetime",
		});
		expect(firstMetadata.dateRecovery).toMatchObject({
			recoveredField: "posted_at",
			recoveredFrom: "message_received_at",
			recoveredValue: "2026-02-01T06:45:35.000Z",
			originalPeriod: "2026-01",
		});

		const second = await financeKnowledge.rebuildFinanceKnowledge();
		const secondEntry = await db
			.selectFrom("finance_ledger_entries")
			.select(["canonical_key", "posted_at", "ledger_metadata_json"])
			.executeTakeFirstOrThrow();

		expect(second).toMatchObject({ ready: 1, review: 0 });
		expect(secondEntry).toMatchObject({
			canonical_key:
				"composite:business|acct:checking|2026-02-01|42-00|USD|digitalocean",
			posted_at: "2026-02-01T06:45:35.000Z",
		});
		expect(JSON.parse(secondEntry.ledger_metadata_json)).toMatchObject({
			dateRecovery: {
				recoveredField: "posted_at",
				recoveredFrom: "message_received_at",
				originalPeriod: "2026-01",
			},
		});
	});

	it("lets imported rows outrank duplicate email evidence", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		await seedFinanceMessage(db, {
			messageId: "message-duplicate-email",
			result: buildFinanceIntelV3({
				transactionCandidates: [
					{
						externalTransactionId: "ext-1",
						merchantOrCounterparty: "Example SaaS",
						financialAccountRef: "acct:checking",
						institutionRef: "inst:bank",
					},
				],
			}),
		});
		await db
			.insertInto("finance_import_runs")
			.values({
				id: "import-run-1",
				source_kind: "csv",
				source_file_path: "/tmp/statement.csv",
				source_file_sha256: "statement-sha",
				filename: "statement.csv",
				artifact_sha256: "artifact-sha",
				extractor_runner: "test",
				extractor_model: "fixture",
				extractor_prompt_version: "finance-source-import.v2",
				extracted_text_hash: null,
				status: "imported",
				raw_artifact_json: "{}",
				imported_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_transactions")
			.values({
				id: "import-tx-1",
				import_run_id: "import-run-1",
				source_document_ref: "stmt-1",
				occurred_at: "2026-01-02",
				posted_at: "2026-01-03",
				amount_value: "42.00",
				amount_minor: 4200,
				currency: "USD",
				direction: "expense",
				description: "Example SaaS import",
				merchant_or_counterparty: "Example SaaS",
				balance_value: null,
				owner_identity_hint: "owner:business",
				financial_account_hint: "acct:checking",
				institution_hint: "inst:bank",
				category_primary: "software_services",
				category_secondary: "saas",
				evidence_text: "CSV row.",
				payload_json: "{}",
				external_transaction_id: "ext-1",
				cleared_at: null,
				statement_row_id: "row-1",
				row_index: 0,
				account_mapping_key: "bank:checking",
				book_hint: "business",
				business_use_percent: null,
				extraction_confidence: 0.99,
				raw_row_payload_json: "{}",
				row_provenance_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();
		const entry = await db
			.selectFrom("finance_ledger_entries")
			.selectAll()
			.executeTakeFirstOrThrow();
		const sources = await db
			.selectFrom("finance_ledger_entry_sources")
			.select(["source_kind"])
			.orderBy("source_kind", "asc")
			.execute();

		expect(result.entries).toBe(1);
		expect(entry.source_authority).toBe("csv");
		expect(entry.canonical_key).toBe("external:inst-bank:acct-checking:ext-1");
		expect(sources.map((source) => source.source_kind)).toEqual([
			"csv",
			"email",
		]);
	});

	it("keeps OFX and PDF at equal merge priority", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		await db
			.insertInto("finance_import_runs")
			.values([
				{
					id: "import-run-pdf",
					source_kind: "pdf",
					source_file_path: "/tmp/statement.pdf",
					source_file_sha256: "statement-pdf-sha",
					filename: "statement.pdf",
					artifact_sha256: "artifact-pdf-sha",
					extractor_runner: "test",
					extractor_model: "fixture",
					extractor_prompt_version: "finance-source-import.v2",
					extracted_text_hash: null,
					status: "imported",
					raw_artifact_json: "{}",
					imported_at: "2026-01-03T00:00:00.000Z",
				},
				{
					id: "import-run-ofx",
					source_kind: "ofx",
					source_file_path: "/tmp/statement.ofx",
					source_file_sha256: "statement-ofx-sha",
					filename: "statement.ofx",
					artifact_sha256: "artifact-ofx-sha",
					extractor_runner: "test",
					extractor_model: "fixture",
					extractor_prompt_version: "finance-source-import.v2",
					extracted_text_hash: null,
					status: "imported",
					raw_artifact_json: "{}",
					imported_at: "2026-01-04T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_import_transactions")
			.values([
				{
					id: "import-tx-pdf",
					import_run_id: "import-run-pdf",
					source_document_ref: "pdf-doc",
					occurred_at: "2026-01-02",
					posted_at: "2026-01-03",
					amount_value: "42.00",
					amount_minor: 4200,
					currency: "USD",
					direction: "expense",
					description: "PDF import",
					merchant_or_counterparty: "Example SaaS",
					balance_value: null,
					owner_identity_hint: "owner:business",
					financial_account_hint: "acct:checking",
					institution_hint: "inst:bank",
					category_primary: "software_services",
					category_secondary: "saas",
					evidence_text: "PDF row.",
					payload_json: "{}",
					external_transaction_id: "ext-shared",
					cleared_at: null,
					statement_row_id: "pdf-row",
					row_index: 0,
					account_mapping_key: "bank:checking",
					book_hint: "business",
					business_use_percent: null,
					extraction_confidence: 0.99,
					raw_row_payload_json: "{}",
					row_provenance_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-01-03T00:00:00.000Z",
				},
				{
					id: "import-tx-ofx",
					import_run_id: "import-run-ofx",
					source_document_ref: "ofx-doc",
					occurred_at: "2026-01-02",
					posted_at: "2026-01-03",
					amount_value: "42.00",
					amount_minor: 4200,
					currency: "USD",
					direction: "expense",
					description: "OFX import",
					merchant_or_counterparty: "Example SaaS",
					balance_value: null,
					owner_identity_hint: "owner:business",
					financial_account_hint: "acct:checking",
					institution_hint: "inst:bank",
					category_primary: "software_services",
					category_secondary: "saas",
					evidence_text: "OFX row.",
					payload_json: "{}",
					external_transaction_id: "ext-shared",
					cleared_at: null,
					statement_row_id: "ofx-row",
					row_index: 0,
					account_mapping_key: "bank:checking",
					book_hint: "business",
					business_use_percent: null,
					extraction_confidence: 0.99,
					raw_row_payload_json: "{}",
					row_provenance_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-01-04T00:00:00.000Z",
				},
			])
			.execute();

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		await financeKnowledge.rebuildFinanceKnowledge();
		const entry = await db
			.selectFrom("finance_ledger_entries")
			.select(["source_authority", "description"])
			.executeTakeFirstOrThrow();
		const sources = await db
			.selectFrom("finance_ledger_entry_sources")
			.select(["source_kind"])
			.orderBy("source_kind", "asc")
			.execute();

		expect(entry).toMatchObject({
			source_authority: "pdf",
			description: "PDF import",
		});
		expect(sources.map((source) => source.source_kind)).toEqual(["ofx", "pdf"]);
	});

	it("links imported statement rows to matching email evidence without external ids", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		await seedFinanceMessage(db, {
			messageId: "message-statement-email-match",
			result: buildFinanceIntelV3(),
		});
		await db
			.insertInto("finance_import_runs")
			.values({
				id: "import-run-statement-match",
				source_kind: "statement",
				source_file_path: "/tmp/statement.pdf",
				source_file_sha256: "statement-sha",
				filename: "statement.pdf",
				artifact_sha256: "artifact-statement-sha",
				extractor_runner: "test",
				extractor_model: "fixture",
				extractor_prompt_version: "finance-source-import.v2",
				extracted_text_hash: null,
				status: "imported",
				raw_artifact_json: "{}",
				imported_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_transactions")
			.values({
				id: "import-tx-statement-match",
				import_run_id: "import-run-statement-match",
				source_document_ref: "stmt-1",
				occurred_at: "2026-01-01",
				posted_at: "2026-01-02",
				amount_value: "42.00",
				amount_minor: 4200,
				currency: "USD",
				direction: "expense",
				description: "Billing import",
				merchant_or_counterparty: "billing@example.com",
				balance_value: null,
				owner_identity_hint: "owner:business",
				financial_account_hint: "acct:checking",
				institution_hint: "inst:bank",
				category_primary: "software_services",
				category_secondary: "saas",
				evidence_text: "Statement row.",
				payload_json: "{}",
				external_transaction_id: null,
				cleared_at: null,
				statement_row_id: "stmt-row-1",
				row_index: 0,
				account_mapping_key: "bank:checking",
				book_hint: "business",
				business_use_percent: null,
				extraction_confidence: 0.99,
				raw_row_payload_json: "{}",
				row_provenance_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();
		const entry = await db
			.selectFrom("finance_ledger_entries")
			.select(["source_authority", "canonical_key"])
			.executeTakeFirstOrThrow();
		const sources = await db
			.selectFrom("finance_ledger_entry_sources")
			.select(["source_kind"])
			.orderBy("source_kind", "asc")
			.execute();

		expect(result.entries).toBe(1);
		expect(entry.source_authority).toBe("text");
		expect(entry.canonical_key).toBe(
			"composite:business|acct:checking|2026-01-01|42-00|USD|billing-example-com",
		);
		expect(sources.map((source) => source.source_kind)).toEqual([
			"email",
			"text",
		]);
	});

	it("blocks mixed rows without an allocation percent", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		await db
			.insertInto("finance_import_runs")
			.values({
				id: "import-run-mixed",
				source_kind: "csv",
				source_file_path: "/tmp/mixed.csv",
				source_file_sha256: "mixed-sha",
				filename: "mixed.csv",
				artifact_sha256: "mixed-artifact-sha",
				extractor_runner: "test",
				extractor_model: "fixture",
				extractor_prompt_version: "finance-source-import.v2",
				extracted_text_hash: null,
				status: "imported",
				raw_artifact_json: "{}",
				imported_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_transactions")
			.values({
				id: "import-tx-mixed",
				import_run_id: "import-run-mixed",
				source_document_ref: "stmt-mixed",
				occurred_at: "2026-01-02",
				posted_at: "2026-01-03",
				amount_value: "42.00",
				amount_minor: 4200,
				currency: "USD",
				direction: "expense",
				description: "Mixed use SaaS",
				merchant_or_counterparty: "Example SaaS",
				balance_value: null,
				owner_identity_hint: "owner:business",
				financial_account_hint: "acct:checking",
				institution_hint: "inst:bank",
				category_primary: "software_services",
				category_secondary: "saas",
				evidence_text: "CSV row.",
				payload_json: "{}",
				external_transaction_id: null,
				cleared_at: null,
				statement_row_id: "row-mixed",
				row_index: 0,
				account_mapping_key: "bank:checking",
				book_hint: "mixed",
				business_use_percent: null,
				extraction_confidence: 0.99,
				raw_row_payload_json: "{}",
				row_provenance_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();
		const entry = await db
			.selectFrom("finance_ledger_entries")
			.select(["status"])
			.executeTakeFirstOrThrow();

		expect(result.blocked).toBe(1);
		expect(entry.status).toBe("blocked");
	});

	it("builds recurring merchant patterns from repeated staged entries", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedMapping(db);
		await seedFinanceMessage(db, {
			messageId: "message-pattern-1",
			result: buildFinanceIntelV3({
				transactionCandidates: [
					{
						merchantOrCounterparty: "Example SaaS",
						occurredAt: "2026-01-01",
						dedupe: {
							normalizedComposite:
								"business|acct|2026-01-01|42|usd|example-saas",
						},
					},
				],
			}),
		});
		await seedFinanceMessage(db, {
			messageId: "message-pattern-2",
			receivedAt: "2026-02-01T00:00:00.000Z",
			result: buildFinanceIntelV3({
				transactionCandidates: [
					{
						merchantOrCounterparty: "Example SaaS",
						occurredAt: "2026-02-01",
						dedupe: {
							normalizedComposite:
								"business|acct|2026-02-01|42|usd|example-saas",
						},
					},
				],
			}),
		});

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();
		const pattern = await db
			.selectFrom("finance_patterns")
			.selectAll()
			.executeTakeFirstOrThrow();

		expect(result.patterns).toBe(1);
		expect(pattern.pattern_kind).toBe("recurring_merchant");
		expect(pattern.pattern_key).toBe("business:example-saas");
	});

	it("excludes blocked and duplicate ledger rows from rollup totals", () => {
		const baseEntry = {
			sourceKind: "email",
			year: 2026,
			accountId: "acct-1",
			primaryCategory: "software",
			secondaryCategory: "saas",
			direction: "expense",
			amountMinor: 1000,
			occurredAt: "2026-01-01",
			ownerIdentityId: null,
			institutionId: null,
			financialAccountId: null,
			description: "Example",
			counterparty: "Example",
			canonicalKey: "entry",
			book: "business",
			accountMappingKey: "example",
		};

		const view = buildFinanceRollupView({
			ledger: [
				{ ...baseEntry, status: "ready", canonicalKey: "ready" },
				{ ...baseEntry, status: "review", canonicalKey: "review" },
				{ ...baseEntry, status: "blocked", canonicalKey: "blocked" },
				{ ...baseEntry, status: "duplicate", canonicalKey: "duplicate" },
			],
			importDocuments: [],
		});

		expect(view.summary.outflowMinor).toBe(2000);
		expect(view.summary.extractedTransactionCount).toBe(2);
		expect(view.rollups).toEqual([
			expect.objectContaining({
				outflowMinor: 2000,
				transactionCount: 2,
				extractedTransactionCount: 2,
			}),
		]);
		expect(view.subcategoryRollups).toEqual([
			expect.objectContaining({
				outflowMinor: 2000,
				transactionCount: 2,
			}),
		]);
	});

	it("excludes ambiguous ledger directions from rollup totals and counts", () => {
		const baseEntry = {
			sourceKind: "email",
			year: 2026,
			accountId: "acct-1",
			primaryCategory: "uncategorized",
			secondaryCategory: null,
			amountMinor: 1000,
			occurredAt: "2026-01-01",
			ownerIdentityId: null,
			institutionId: null,
			financialAccountId: null,
			description: "Example",
			counterparty: "Example",
			status: "ready",
			canonicalKey: "entry",
			book: "business",
			accountMappingKey: "example",
		};

		const view = buildFinanceRollupView({
			ledger: [
				{ ...baseEntry, direction: "income", canonicalKey: "income" },
				{ ...baseEntry, direction: "expense", canonicalKey: "expense" },
				{ ...baseEntry, direction: "unknown", canonicalKey: "unknown" },
				{ ...baseEntry, direction: "both", canonicalKey: "both" },
				{ ...baseEntry, direction: "neither", canonicalKey: "neither" },
			],
			importDocuments: [],
		});

		expect(view.summary).toMatchObject({
			inflowMinor: 1000,
			outflowMinor: 1000,
			netMinor: 0,
			extractedTransactionCount: 2,
			uncategorizedCount: 2,
		});
		expect(view.rollups).toEqual([
			expect.objectContaining({
				inflowMinor: 1000,
				outflowMinor: 1000,
				netMinor: 0,
				transactionCount: 2,
				extractedTransactionCount: 2,
				uncategorizedCount: 2,
			}),
		]);
		expect(view.subcategoryRollups).toEqual([
			expect.objectContaining({
				inflowMinor: 1000,
				outflowMinor: 1000,
				netMinor: 0,
				transactionCount: 2,
			}),
		]);
	});
});
