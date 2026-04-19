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

describe("loadFinanceData filter contract", () => {
	it("uses materialized rollups by default and derives filtered views from the ledger", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			label: "Finance Account",
			emailAddress: "finance@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
		});

		const emailMessageId = await insertMessageRow(db, {
			id: "msg-finance-email",
			accountId: "acct-1",
			senderAddress: "billing@acme.example",
			subject: "Acme Cloud receipt",
			bodyTextNormalized: "Expense receipt for Acme Cloud",
			receivedAt: "2026-03-15T12:00:00.000Z",
			contentSha256: "sha-finance-email",
		});
		await insertMessageLabelRow(db, {
			messageId: emailMessageId,
			contentSha256: "sha-finance-email",
			primaryBucket: "finance",
			label: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Acme Cloud receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
			}),
		});
		await insertSecondaryResultRow(db, {
			messageId: emailMessageId,
			contentSha256: "sha-finance-email",
			result: buildFinanceIntelV3({
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-03-15",
						merchantOrCounterparty: "Acme Cloud",
						ownerIdentityRef: "owner:email",
						financialAccountRef: "acct:finance",
						institutionRef: "inst:email-bank",
						categoryPrimary: "software_services",
						categorySecondary: "saas",
						statementRefHint: null,
						taxRelevanceHint: "business expense",
						evidence: "Acme email charge.",
						externalTransactionId: null,
						postedAt: null,
						clearedAt: null,
						book: "business",
						businessUsePercent: null,
						fieldConfidence: {
							amount: 0.95,
							date: 0.95,
							counterparty: 0.95,
							accountMapping: 0.95,
							book: 0.95,
							category: 0.95,
							dedupe: 0.95,
						},
						dedupe: {
							externalTransactionId: null,
							statementRowId: null,
							normalizedComposite: null,
							emailEvidenceKey: "msg-finance-email:42:2026-03-15",
						},
						beancount: {
							debitAccount: "Expenses:Business:Software",
							creditAccount: "Assets:Business:Bank:Checking",
							currency: "USD",
							mappingKey: "acct:finance",
							confidence: 0.95,
							metadata: {},
						},
					},
				],
			}),
		});

		await db
			.insertInto("finance_import_runs")
			.values({
				id: "import-run-1",
				source_kind: "pdf",
				source_file_path: "/tmp/statement.pdf",
				source_file_sha256: "statement-sha",
				filename: "statement.pdf",
				artifact_sha256: "artifact-sha",
				extractor_runner: "pytest",
				extractor_model: "claude-opus",
				extractor_prompt_version: "finance-source-import.v1",
				extracted_text_hash: "text-sha",
				status: "imported",
				raw_artifact_json: JSON.stringify({
					schemaVersion: "finance-source-import.v1",
				}),
				imported_at: "2026-03-31T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_documents")
			.values({
				id: "import-doc-1",
				import_run_id: "import-run-1",
				source_document_ref: "statement-mar-2026",
				document_type: "statement",
				issuer: "PDF Credit Union",
				external_id: "statement-mar-2026",
				statement_period_start: "2026-03-01",
				statement_period_end: "2026-03-31",
				due_at: null,
				tax_year: 2026,
				owner_identity_hint: "owner:pdf",
				financial_account_hint: "acct:pdf",
				institution_hint: "inst:pdf-bank",
				evidence_text: "Imported PDF statement for March.",
				payload_json: JSON.stringify({ seeded: true }),
				created_at: "2026-03-31T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_transactions")
			.values({
				id: "import-tx-1",
				import_run_id: "import-run-1",
				source_document_ref: "statement-mar-2026",
				occurred_at: "2026-03-20",
				posted_at: "2026-03-21",
				amount_value: "51.00",
				amount_minor: 5100,
				currency: "USD",
				direction: "expense",
				description: "Imported PDF software charge",
				merchant_or_counterparty: "PDF Services",
				balance_value: null,
				owner_identity_hint: "owner:pdf",
				financial_account_hint: "acct:pdf",
				institution_hint: "inst:pdf-bank",
				category_primary: "software_services",
				category_secondary: "statement_import",
				evidence_text: "Imported PDF charge.",
				payload_json: JSON.stringify({ seeded: true }),
				created_at: "2026-03-31T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-email-1",
					canonical_key: "email:msg-finance-email:42.00:2026-03-15",
					status: "ready",
					source_authority: "email",
					occurred_at: "2026-03-15",
					posted_at: null,
					cleared_at: null,
					description: "Acme Cloud",
					counterparty: "Acme Cloud",
					direction: "expense",
					amount_value: "42.00",
					amount_minor: 4200,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Software",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "acct:finance",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "software_services",
						categorySecondary: "saas",
						ownerIdentityId: "owner:email",
						institutionId: "inst:email-bank",
						financialAccountId: "acct:finance",
					}),
					raw_payload_json: JSON.stringify({ seeded: true }),
					created_at: "2026-03-31T00:00:00.000Z",
					updated_at: "2026-03-31T00:00:00.000Z",
				},
				{
					id: "ledger-pdf-1",
					canonical_key: "import:artifact-sha:0",
					status: "ready",
					source_authority: "pdf",
					occurred_at: "2026-03-20",
					posted_at: "2026-03-21",
					cleared_at: null,
					description: "Imported PDF software charge",
					counterparty: "PDF Services",
					direction: "expense",
					amount_value: "51.00",
					amount_minor: 5100,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Software",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "bank:checking",
					field_confidence_json: JSON.stringify({ overall: 0.99 }),
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "software_services",
						categorySecondary: "statement_import",
						ownerIdentityId: "owner:pdf",
						institutionId: "inst:pdf-bank",
						financialAccountId: "acct:pdf",
					}),
					raw_payload_json: JSON.stringify({ seeded: true }),
					created_at: "2026-03-31T00:00:00.000Z",
					updated_at: "2026-03-31T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values([
				{
					id: "ledger-source-email-1",
					ledger_entry_id: "ledger-email-1",
					source_kind: "email",
					message_id: emailMessageId,
					secondary_result_id: null,
					import_run_id: null,
					import_transaction_id: null,
					import_document_id: null,
					evidence_json: JSON.stringify({ seeded: true }),
					created_at: "2026-03-31T00:00:00.000Z",
				},
				{
					id: "ledger-source-pdf-1",
					ledger_entry_id: "ledger-pdf-1",
					source_kind: "import",
					message_id: null,
					secondary_result_id: null,
					import_run_id: "import-run-1",
					import_transaction_id: "import-tx-1",
					import_document_id: "import-doc-1",
					evidence_json: JSON.stringify({ seeded: true }),
					created_at: "2026-03-31T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_yearly_rollups")
			.values({
				id: "materialized-rollup-1",
				year: 2026,
				source_kind: "email",
				primary_category: "materialized_only",
				inflow_minor: 0,
				outflow_minor: 999,
				net_minor: -999,
				transaction_count: 1,
				imported_statement_count: 0,
				extracted_transaction_count: 1,
				uncategorized_count: 0,
				created_at: "2026-03-31T00:00:00.000Z",
				updated_at: "2026-03-31T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_yearly_subcategory_rollups")
			.values({
				id: "materialized-sub-rollup-1",
				year: 2026,
				source_kind: "email",
				primary_category: "materialized_only",
				secondary_category: "materialized_sub",
				inflow_minor: 0,
				outflow_minor: 999,
				net_minor: -999,
				transaction_count: 1,
				created_at: "2026-03-31T00:00:00.000Z",
				updated_at: "2026-03-31T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		const unfiltered = await actions.loadFinanceData({ year: 2026 });
		expect(unfiltered.filters.institutions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "inst:email-bank" }),
				expect.objectContaining({ id: "inst:pdf-bank" }),
			]),
		);
		expect(unfiltered.filters.ownerIdentities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "owner:email" }),
				expect.objectContaining({ id: "owner:pdf" }),
			]),
		);
		expect(unfiltered.filters.sourceKinds).toEqual(
			expect.arrayContaining(["email", "pdf"]),
		);
		expect(unfiltered.rollups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ primaryCategory: "materialized_only" }),
			]),
		);

		const pdfFiltered = await actions.loadFinanceData({
			year: 2026,
			sourceKind: "pdf",
			institutionId: "inst:pdf-bank",
			ownerIdentityId: "owner:pdf",
		});
		expect(pdfFiltered.rollups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceKind: "pdf",
					primaryCategory: "software_services",
				}),
			]),
		);
		expect(pdfFiltered.subcategoryRollups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceKind: "pdf",
					secondaryCategory: "statement_import",
				}),
			]),
		);
		expect(pdfFiltered.ledgerPreview).toEqual([
			expect.objectContaining({
				sourceKind: "pdf",
				institutionId: "inst:pdf-bank",
				ownerIdentityId: "owner:pdf",
			}),
		]);
		expect(pdfFiltered.importedDocuments).toEqual([
			expect.objectContaining({
				institutionHint: "inst:pdf-bank",
				ownerIdentityHint: "owner:pdf",
			}),
		]);

		const accountFiltered = await actions.loadFinanceData({
			year: 2026,
			accountId: "acct-1",
		});
		expect(accountFiltered.rollups).toEqual([
			expect.objectContaining({
				sourceKind: "email",
				primaryCategory: "software_services",
			}),
		]);
		expect(accountFiltered.importedDocuments).toEqual([]);
		expect(accountFiltered.ledgerPreview).toEqual([
			expect.objectContaining({
				accountId: "acct-1",
				sourceKind: "email",
			}),
		]);
	});
});
