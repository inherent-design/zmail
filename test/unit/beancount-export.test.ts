import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

function beanCheckInstalled() {
	const result = spawnSync("bean-check", ["--help"], { encoding: "utf8" });
	return !(
		result.error &&
		"code" in result.error &&
		result.error.code === "ENOENT"
	);
}

describe("beancount export", () => {
	it("writes ready rows to Beancount and unresolved rows to sidecars", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-ready-1",
					canonical_key:
						"composite:business:checking:2026-01-02:42:usd:example-saas",
					status: "ready",
					source_authority: "email",
					occurred_at: "2026-01-02",
					posted_at: null,
					cleared_at: null,
					description: "Example SaaS receipt",
					counterparty: "Example SaaS",
					direction: "expense",
					amount_value: "42.00",
					amount_minor: 4200,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Software",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "bank:checking",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-01-02T00:00:00.000Z",
					updated_at: "2026-01-02T00:00:00.000Z",
				},
				{
					id: "ledger-review-1",
					canonical_key: "email:review",
					status: "review",
					source_authority: "email",
					occurred_at: "2026-01-03",
					posted_at: null,
					cleared_at: null,
					description: "Needs mapping",
					counterparty: "Unknown",
					direction: "expense",
					amount_value: "10.00",
					amount_minor: 1000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: null,
					credit_account: null,
					account_mapping_key: null,
					field_confidence_json: JSON.stringify({ overall: 0.5 }),
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-01-03T00:00:00.000Z",
					updated_at: "2026-01-03T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values({
				id: "ledger-source-ready-1",
				ledger_entry_id: "ledger-ready-1",
				source_kind: "email",
				message_id: null,
				secondary_result_id: null,
				import_run_id: null,
				import_transaction_id: null,
				import_document_id: null,
				evidence_json: "{}",
				created_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "export");
		const result = await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		expect(result.exported).toBe(1);
		expect(result.unresolved).toBe(1);
		expect(existsSync(join(outDir, "main.beancount"))).toBe(true);
		const generated = readFileSync(
			join(outDir, "generated", "2026.beancount"),
			"utf8",
		);
		expect(generated).toContain("2026-01-02");
		expect(generated).toContain("zmail_book:");
		expect(generated).toContain(
			"^zmail-composite-business-checking-2026-01-02-42-usd-example-saas",
		);
		expect(generated).toContain("Expenses:Business:Software  42.00 USD");
		expect(generated).toContain("Assets:Business:Bank:Checking  -42.00 USD");
		const accounts = readFileSync(join(outDir, "accounts.beancount"), "utf8");
		expect(accounts).toContain("2026-01-01 open Assets:Business:Bank:Checking");
		expect(accounts).toContain("2026-01-01 open Expenses:Business:Software");
		expect(accounts).not.toMatch(/\bopen\b.*\bUSD\b/);
		const main = readFileSync(join(outDir, "main.beancount"), "utf8");
		expect(main).toContain('option "operating_currency" "USD"');
		const unresolved = readFileSync(
			join(outDir, "review", "unresolved.csv"),
			"utf8",
		);
		expect(unresolved).toContain("email:review");
		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as {
			validation: { beanCheck: string; internal?: { status: string } };
			items: Array<Record<string, unknown>>;
		};
		expect(manifest.validation.internal?.status).toBe("passed");
		expect(manifest.items).toHaveLength(2);
		expect(manifest.items[0]).toMatchObject({
			beancountDate: "2026-01-02",
			beancountDateSource: "occurred_at",
			dateRecovery: null,
		});
		expect(manifest.items[1]).toMatchObject({
			beancountDate: "2026-01-03",
			beancountDateSource: "occurred_at",
			dateRecovery: null,
		});
	});

	it("exports partial occurred_at rows with exact posted_at fallback metadata", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-ready-partial-date",
				canonical_key: "composite:business|acct|2026-01|42-00|USD|digitalocean",
				status: "ready",
				source_authority: "email",
				occurred_at: "2026-01",
				posted_at: "2026-01-02T10:00:00.000Z",
				cleared_at: null,
				description: "DigitalOcean invoice",
				counterparty: "DigitalOcean",
				direction: "expense",
				amount_value: "42.00",
				amount_minor: 4200,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: "Expenses:Business:Hosting",
				credit_account: "Assets:Business:Bank:Checking",
				account_mapping_key: "hosting",
				field_confidence_json: JSON.stringify({ overall: 0.95 }),
				ledger_metadata_json: JSON.stringify({
					dateRecovery: {
						recoveredField: "posted_at",
						recoveredFrom: "message_received_at",
						originalPeriod: "2026-01",
					},
				}),
				raw_payload_json: "{}",
				created_at: "2026-01-02T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "partial-date-export");
		const result = await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		expect(result.exported).toBe(1);
		const generated = readFileSync(
			join(outDir, "generated", "2026.beancount"),
			"utf8",
		);
		expect(generated).toContain("2026-01-02");
		expect(generated).toContain('zmail_beancount_date_source: "posted_at"');
		expect(generated).toContain('zmail_occurred_at: "2026-01"');
		expect(generated).toContain('zmail_posted_at: "2026-01-02T10:00:00.000Z"');
		expect(generated).toContain("zmail_date_recovery:");
		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as { items: Array<Record<string, unknown>> };
		expect(manifest.items[0]).toMatchObject({
			beancountDate: "2026-01-02",
			beancountDateSource: "posted_at",
			dateRecovery: {
				recoveredField: "posted_at",
				recoveredFrom: "message_received_at",
				originalPeriod: "2026-01",
			},
		});
	});

	it("keeps rows with only partial dates in unresolved sidecars", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-partial-only",
				canonical_key: "email:partial-only",
				status: "ready",
				source_authority: "email",
				occurred_at: "2026-01",
				posted_at: null,
				cleared_at: null,
				description: "Partial only",
				counterparty: "Example",
				direction: "expense",
				amount_value: "12.00",
				amount_minor: 1200,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: "Expenses:Business:Software",
				credit_account: "Assets:Business:Bank:Checking",
				account_mapping_key: "bank:checking",
				field_confidence_json: JSON.stringify({ overall: 0.95 }),
				ledger_metadata_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "partial-only-export");
		const result = await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		expect(result.exported).toBe(0);
		expect(result.unresolved).toBe(1);
		const unresolved = readFileSync(
			join(outDir, "review", "unresolved.csv"),
			"utf8",
		);
		expect(unresolved).toContain("missing_exact_beancount_date");
		expect(unresolved).toContain("2026-01");
	});

	it("records bean-check as passed when installed", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-ready-bean-check",
				canonical_key: "expense:bean-check",
				status: "ready",
				source_authority: "email",
				occurred_at: "2026-03-01",
				posted_at: null,
				cleared_at: null,
				description: "Bean check",
				counterparty: "Bean Check Vendor",
				direction: "expense",
				amount_value: "15.00",
				amount_minor: 1500,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: "Expenses:Business:Software",
				credit_account: "Assets:Business:Bank:Checking",
				account_mapping_key: "bank:checking",
				field_confidence_json: JSON.stringify({ overall: 0.95 }),
				ledger_metadata_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-03-01T00:00:00.000Z",
				updated_at: "2026-03-01T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "bean-check-export");
		await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as { validation: { beanCheck: string } };
		if (beanCheckInstalled()) {
			expect(manifest.validation.beanCheck).toBe("passed");
		} else {
			expect(manifest.validation.beanCheck).toBe("skipped");
		}
	});

	it("fails internal validation when generated file list and body disagree", async () => {
		const runtime = await createTestRuntime();
		const { runInternalExportValidation } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const packageDir = join(runtime.root, "internal-validation");
		mkdirSync(join(packageDir, "generated"), { recursive: true });
		writeFileSync(
			join(packageDir, "generated", "2026.beancount"),
			[
				'2026-01-02 * "Vendor" "Expense" ^zmail-txn-123',
				"  Expenses:Business:Software  42.00 USD",
				"  Assets:Business:Bank:Checking  -42.00 USD",
				"",
			].join("\n"),
			"utf8",
		);
		const manifest = {
			files: {
				generated: [],
				documents: [],
			},
			items: [
				{
					canonicalKey: "txn-123",
					status: "exported",
					beancountLink: "zmail-txn-123",
				},
			],
			rows: [
				{
					ledgerEntry: { canonical_key: "txn-123" },
					export: {
						status: "exported",
						generatedFile: "generated/2026.beancount",
						beancountLink: "zmail-txn-123",
					},
				},
			],
		} as unknown as Parameters<
			typeof runInternalExportValidation
		>[0]["manifest"];

		const result = runInternalExportValidation({
			packageDir,
			manifest,
			generatedFiles: [
				{
					relativePath: "generated/2026.beancount",
					body: readFileSync(
						join(packageDir, "generated", "2026.beancount"),
						"utf8",
					),
				},
			],
			exportedTransactions: [
				{
					canonicalKey: "txn-123",
					beancountDate: "2026-01-02",
					generatedFile: "generated/2026.beancount",
					beancountLink: "zmail-txn-123",
					body: readFileSync(
						join(packageDir, "generated", "2026.beancount"),
						"utf8",
					),
				},
			],
			exportedRowCount: 1,
			unresolvedRowCount: 0,
		});

		expect(result.status).toBe("failed");
		expect(result.checks).toContainEqual(
			expect.objectContaining({
				name: "generated-files-match-manifest",
				status: "failed",
			}),
		);
	});

	it("writes multi-currency Beancount exports without USD-only account opens", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-ready-eur",
					canonical_key: "expense:eur",
					status: "ready",
					source_authority: "pdf",
					occurred_at: "2026-02-01",
					posted_at: null,
					cleared_at: null,
					description: "Berlin hotel",
					counterparty: "Berlin Hotel",
					direction: "expense",
					amount_value: "80.00",
					amount_minor: 8000,
					currency: "EUR",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Travel",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "card:travel",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-02-01T00:00:00.000Z",
					updated_at: "2026-02-01T00:00:00.000Z",
				},
				{
					id: "ledger-ready-usd",
					canonical_key: "income:usd",
					status: "ready",
					source_authority: "email",
					occurred_at: "2026-02-02",
					posted_at: null,
					cleared_at: null,
					description: "Client payment",
					counterparty: "Client",
					direction: "income",
					amount_value: "120.00",
					amount_minor: 12000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Assets:Business:Bank:Checking",
					credit_account: "Income:Business:GrossReceipts",
					account_mapping_key: "client:income",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-02-02T00:00:00.000Z",
					updated_at: "2026-02-02T00:00:00.000Z",
				},
			])
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "multi-currency-export");
		const result = await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		expect(result.exported).toBe(2);
		const generated = readFileSync(
			join(outDir, "generated", "2026.beancount"),
			"utf8",
		);
		expect(generated).toContain("Expenses:Business:Travel  80.00 EUR");
		expect(generated).toContain("Income:Business:GrossReceipts  -120.00 USD");
		const accounts = readFileSync(join(outDir, "accounts.beancount"), "utf8");
		expect(accounts).toContain("2026-01-01 open Expenses:Business:Travel");
		expect(accounts).toContain("2026-01-01 open Income:Business:GrossReceipts");
		expect(accounts).not.toMatch(/\bopen\b.*\bUSD\b/);
		expect(accounts).not.toMatch(/\bopen\b.*\bEUR\b/);
		const main = readFileSync(join(outDir, "main.beancount"), "utf8");
		expect(main.indexOf('option "operating_currency" "EUR"')).toBeLessThan(
			main.indexOf('option "operating_currency" "USD"'),
		);
	});

	it("refuses to overwrite an existing export target unless forced", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });
		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "export");
		mkdirSync(outDir);
		const sentinel = join(outDir, "main.beancount");
		writeFileSync(sentinel, "existing", "utf8");

		await expect(
			exportFinanceBeancountPackage({
				orgId: currentOrgId(),
				outDir,
				year: 2026,
				strict: true,
			}),
		).rejects.toThrow("Export target already exists");
		expect(readFileSync(sentinel, "utf8")).toBe("existing");

		await expect(
			exportFinanceBeancountPackage({
				orgId: currentOrgId(),
				outDir,
				year: 2026,
				strict: true,
				force: true,
			}),
		).resolves.toMatchObject({ outDir });
		expect(readFileSync(sentinel, "utf8")).toContain("include");
	});

	it("exports all available years when year is omitted", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-ready-2025",
					canonical_key: "expense:2025",
					status: "ready",
					source_authority: "email",
					occurred_at: "2025-12-31",
					posted_at: null,
					cleared_at: null,
					description: "Prior year expense",
					counterparty: "Vendor One",
					direction: "expense",
					amount_value: "10.00",
					amount_minor: 1000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Software",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "vendor:one",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2025-12-31T00:00:00.000Z",
					updated_at: "2025-12-31T00:00:00.000Z",
				},
				{
					id: "ledger-ready-2026",
					canonical_key: "expense:2026",
					status: "ready",
					source_authority: "email",
					occurred_at: "2026-01-01",
					posted_at: null,
					cleared_at: null,
					description: "Current year expense",
					counterparty: "Vendor Two",
					direction: "expense",
					amount_value: "20.00",
					amount_minor: 2000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Software",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "vendor:two",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-01T00:00:00.000Z",
				},
			])
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "all-years-export");
		await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			strict: true,
		});

		expect(existsSync(join(outDir, "generated", "2025.beancount"))).toBe(true);
		expect(existsSync(join(outDir, "generated", "2026.beancount"))).toBe(true);
		const main = readFileSync(join(outDir, "main.beancount"), "utf8");
		expect(main).toContain('include "generated/2025.beancount"');
		expect(main).toContain('include "generated/2026.beancount"');
		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as { schemaVersion: string; years: number[] };
		expect(manifest.schemaVersion).toBe("finance-ledger-export.v2");
		expect(manifest.years).toEqual([2025, 2026]);
	});

	it("keeps rows with missing counterparty out of Beancount output", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-missing-counterparty",
				canonical_key: "expense:missing-counterparty",
				status: "ready",
				source_authority: "email",
				occurred_at: "2026-05-01",
				posted_at: null,
				cleared_at: null,
				description: "Counterparty missing",
				counterparty: null,
				direction: "expense",
				amount_value: "15.00",
				amount_minor: 1500,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: "Expenses:Business:Software",
				credit_account: "Assets:Business:Bank:Checking",
				account_mapping_key: "vendor:missing",
				field_confidence_json: JSON.stringify({ overall: 0.95 }),
				ledger_metadata_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-05-01T00:00:00.000Z",
				updated_at: "2026-05-01T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "missing-counterparty-export");
		const result = await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		expect(result.exported).toBe(0);
		const unresolved = readFileSync(
			join(outDir, "review", "unresolved.csv"),
			"utf8",
		);
		expect(unresolved).toContain("missing_counterparty");
	});

	it("emits document directives for import-backed files when available", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const sourcePath = join(runtime.root, "statement.pdf");
		writeFileSync(sourcePath, "pdf", "utf8");
		await db
			.insertInto("finance_import_runs")
			.values({
				id: "import-run-1",
				source_kind: "pdf",
				source_file_path: sourcePath,
				source_file_sha256: "source-sha",
				filename: "statement.pdf",
				artifact_sha256: "artifact-sha",
				extractor_runner: "test",
				extractor_model: "test",
				extractor_prompt_version: "test",
				extracted_text_hash: null,
				status: "imported",
				raw_artifact_json: "{}",
				imported_at: "2026-06-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_documents")
			.values({
				id: "import-doc-1",
				import_run_id: "import-run-1",
				source_document_ref: "statement.pdf",
				document_type: "statement",
				issuer: "Example Bank",
				external_id: null,
				statement_period_start: "2026-06-01",
				statement_period_end: "2026-06-30",
				due_at: null,
				tax_year: 2026,
				owner_identity_hint: null,
				financial_account_hint: null,
				institution_hint: null,
				evidence_text: "Statement",
				payload_json: "{}",
				statement_opening_balance: null,
				statement_closing_balance: null,
				statement_transaction_count: null,
				statement_currency: null,
				account_mapping_key: null,
				extraction_confidence: 0,
				raw_document_payload_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-06-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-import-doc",
				canonical_key: "expense:import-doc",
				status: "ready",
				source_authority: "pdf",
				occurred_at: "2026-06-15",
				posted_at: null,
				cleared_at: null,
				description: "Import backed expense",
				counterparty: "Example Bank",
				direction: "expense",
				amount_value: "25.00",
				amount_minor: 2500,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: "Expenses:Business:Software",
				credit_account: "Assets:Business:Bank:Checking",
				account_mapping_key: "import:doc",
				field_confidence_json: JSON.stringify({ overall: 0.95 }),
				ledger_metadata_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-06-15T00:00:00.000Z",
				updated_at: "2026-06-15T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values({
				id: "ledger-source-import-doc",
				ledger_entry_id: "ledger-import-doc",
				source_kind: "pdf",
				message_id: null,
				secondary_result_id: null,
				import_run_id: "import-run-1",
				import_transaction_id: null,
				import_document_id: "import-doc-1",
				evidence_json: "{}",
				created_at: "2026-06-15T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "document-export");
		await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		const generated = readFileSync(
			join(outDir, "generated", "2026.beancount"),
			"utf8",
		);
		expect(generated).toContain("document Assets:Business:Bank:Checking");
		expect(
			existsSync(join(outDir, "documents", "import-doc-1-statement.pdf")),
		).toBe(true);
		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as {
			files: { documents: string[] };
			documentsMeta?: {
				copied: Array<Record<string, unknown>>;
				missing: Array<Record<string, unknown>>;
			};
		};
		expect(manifest.files.documents).toContain(
			"documents/import-doc-1-statement.pdf",
		);
		expect(manifest.documentsMeta?.copied).toContainEqual(
			expect.objectContaining({
				relativePath: "documents/import-doc-1-statement.pdf",
				importRunId: "import-run-1",
				importDocumentId: "import-doc-1",
				sourceDocumentRef: "statement.pdf",
				sourcePath,
			}),
		);
		expect(manifest.documentsMeta?.missing).toEqual([]);

		rmSync(sourcePath, { force: true });
	});

	it("records missing import-run source files without blocking export", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const sourcePath = join(runtime.root, "missing-statement.pdf");
		await db
			.insertInto("finance_import_runs")
			.values({
				id: "import-run-missing-doc",
				source_kind: "pdf",
				source_file_path: sourcePath,
				source_file_sha256: "source-sha",
				filename: "missing-statement.pdf",
				artifact_sha256: "artifact-sha",
				extractor_runner: "test",
				extractor_model: "test",
				extractor_prompt_version: "test",
				extracted_text_hash: null,
				status: "imported",
				raw_artifact_json: "{}",
				imported_at: "2026-07-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_import_documents")
			.values({
				id: "import-doc-missing",
				import_run_id: "import-run-missing-doc",
				source_document_ref: "missing-statement.pdf",
				document_type: "statement",
				issuer: "Example Bank",
				external_id: null,
				statement_period_start: "2026-07-01",
				statement_period_end: "2026-07-31",
				due_at: null,
				tax_year: 2026,
				owner_identity_hint: null,
				financial_account_hint: null,
				institution_hint: null,
				evidence_text: "Statement",
				payload_json: "{}",
				statement_opening_balance: null,
				statement_closing_balance: null,
				statement_transaction_count: null,
				statement_currency: null,
				account_mapping_key: null,
				extraction_confidence: 0,
				raw_document_payload_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-07-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-import-missing-doc",
				canonical_key: "expense:import-missing-doc",
				status: "ready",
				source_authority: "pdf",
				occurred_at: "2026-07-15",
				posted_at: null,
				cleared_at: null,
				description: "Import backed expense",
				counterparty: "Example Bank",
				direction: "expense",
				amount_value: "25.00",
				amount_minor: 2500,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: "Expenses:Business:Software",
				credit_account: "Assets:Business:Bank:Checking",
				account_mapping_key: "import:doc",
				field_confidence_json: JSON.stringify({ overall: 0.95 }),
				ledger_metadata_json: "{}",
				raw_payload_json: "{}",
				created_at: "2026-07-15T00:00:00.000Z",
				updated_at: "2026-07-15T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values({
				id: "ledger-source-import-missing-doc",
				ledger_entry_id: "ledger-import-missing-doc",
				source_kind: "pdf",
				message_id: null,
				secondary_result_id: null,
				import_run_id: "import-run-missing-doc",
				import_transaction_id: null,
				import_document_id: "import-doc-missing",
				evidence_json: "{}",
				created_at: "2026-07-15T00:00:00.000Z",
			})
			.execute();

		const { exportFinanceBeancountPackage } = await runtime.importFresh<
			typeof import("#/lib/beancount-export")
		>("#/lib/beancount-export");
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);
		const outDir = join(runtime.root, "missing-document-export");
		const result = await exportFinanceBeancountPackage({
			orgId: currentOrgId(),
			outDir,
			year: 2026,
			strict: true,
		});

		expect(result.exported).toBe(1);
		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as {
			files: { documents: string[] };
			documentsMeta?: {
				copied: Array<Record<string, unknown>>;
				missing: Array<Record<string, unknown>>;
			};
		};
		expect(manifest.files.documents).toEqual([]);
		expect(manifest.documentsMeta?.copied).toEqual([]);
		expect(manifest.documentsMeta?.missing).toContainEqual(
			expect.objectContaining({
				importRunId: "import-run-missing-doc",
				importDocumentId: "import-doc-missing",
				sourceDocumentRef: "missing-statement.pdf",
				sourcePath,
				reason: "source_file_missing",
			}),
		);
	});
});
