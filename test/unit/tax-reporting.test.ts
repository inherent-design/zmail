import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("tax reporting", () => {
	it("writes audit packages when accepted rows are not ready-safe", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-ready-unknown-direction",
					canonical_key: "ready-unknown-direction",
					status: "ready",
					source_authority: "email",
					occurred_at: "2025-02-01",
					posted_at: null,
					cleared_at: null,
					description: "Ready but not countable",
					counterparty: "Example",
					direction: "unknown",
					amount_value: "12.00",
					amount_minor: 1200,
					currency: "USD",
					book: "personal",
					business_use_percent: null,
					debit_account: "Expenses:Personal:Misc",
					credit_account: "Assets:Personal:Checking",
					account_mapping_key: "personal:checking",
					field_confidence_json: "{}",
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2025-02-01T00:00:00.000Z",
					updated_at: "2025-02-01T00:00:00.000Z",
				},
				{
					id: "ledger-review",
					canonical_key: "review-mapping-gap",
					status: "review",
					source_authority: "email",
					occurred_at: "2025-02-02",
					posted_at: null,
					cleared_at: null,
					description: "Needs mapping",
					counterparty: "Unknown",
					direction: "expense",
					amount_value: "10.00",
					amount_minor: 1000,
					currency: "USD",
					book: "personal",
					business_use_percent: null,
					debit_account: null,
					credit_account: null,
					account_mapping_key: null,
					field_confidence_json: "{}",
					ledger_metadata_json: "{}",
					raw_payload_json: "{}",
					created_at: "2025-02-02T00:00:00.000Z",
					updated_at: "2025-02-02T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values({
				id: "source-review",
				ledger_entry_id: "ledger-review",
				source_kind: "email",
				message_id: null,
				secondary_result_id: null,
				import_run_id: null,
				import_transaction_id: null,
				import_document_id: null,
				evidence_json: JSON.stringify({ rawRfc822Body: "do-not-export" }),
				created_at: "2025-02-02T00:00:00.000Z",
			})
			.execute();
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		await jobs.queueJobIdempotent({
			kind: "rebuild_finance_knowledge",
			scopeType: "system",
			scopeId: "finance",
		});

		const { generateTaxReportPackage } = await runtime.importFresh<
			typeof import("#/lib/tax-reporting")
		>("#/lib/tax-reporting");
		const outDir = join(runtime.root, "tax-report");
		const result = await generateTaxReportPackage({
			reportRunId: "tax-run-1",
			reportKind: "personal_annual",
			year: 2025,
			outDir,
		});

		expect(result).toMatchObject({
			status: "audit_only",
			acceptedRows: 0,
			reviewRows: 2,
		});
		expect(readFileSync(join(outDir, "ledger.csv"), "utf8")).not.toContain(
			"ready-unknown-direction",
		);
		expect(readFileSync(join(outDir, "review.csv"), "utf8")).toContain(
			"ready-unknown-direction",
		);
		const evidence = readFileSync(join(outDir, "evidence.csv"), "utf8");
		expect(evidence).toContain("rawRfc822Body");
		expect(evidence).not.toContain("do-not-export");
		const summary = JSON.parse(
			readFileSync(join(outDir, "summary.json"), "utf8"),
		);
		expect(summary.status).toBe("audit_only");
		expect(summary.snapshot).toMatchObject({
			ledgerRowCount: 2,
			periodLedgerRowCount: 2,
			acceptedLedgerRowCount: 0,
			reviewLedgerRowCount: 2,
			ledgerUpdatedAtMax: "2025-02-02T00:00:00.000Z",
			openJobsAtGeneration: [
				{ kind: "rebuild_finance_knowledge", queued: 1, running: 0 },
			],
		});
		expect(summary.validation).toMatchObject({
			acceptedTotalsUseReadyOnly: true,
			noReadyRows: true,
			rawRfc822Included: false,
			fullAccountNumbersIncluded: false,
		});
		const formValues = JSON.parse(
			readFileSync(join(outDir, "forms", "form-values.json"), "utf8"),
		);
		expect(formValues).toMatchObject({
			schemaVersion: "tax-form-values.v1",
			readiness: {
				status: "audit_only",
				missing: {
					mapping: 1,
					nonCountableDirection: 1,
				},
			},
		});
		expect(
			readFileSync(join(outDir, "forms", "schedule-c-workpaper.md"), "utf8"),
		).toContain("Candidate values use only `ready`");
	});

	it("writes Schedule C candidate values from ready rows only", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-business-ready-income",
					canonical_key: "business-ready-income",
					status: "ready",
					source_authority: "email",
					occurred_at: "2025-04-01",
					posted_at: null,
					cleared_at: null,
					description: "Client payment",
					counterparty: "Client",
					direction: "income",
					amount_value: "500.00",
					amount_minor: 50000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Assets:Business:Checking",
					credit_account: "Income:Business:GrossReceipts",
					account_mapping_key: "business:income",
					field_confidence_json: "{}",
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "income",
					}),
					raw_payload_json: "{}",
					created_at: "2025-04-01T00:00:00.000Z",
					updated_at: "2025-04-01T00:00:00.000Z",
				},
				{
					id: "ledger-business-ready-software",
					canonical_key: "business-ready-software",
					status: "ready",
					source_authority: "email",
					occurred_at: "2025-04-02",
					posted_at: null,
					cleared_at: null,
					description: "Software",
					counterparty: "Vendor",
					direction: "expense",
					amount_value: "200.00",
					amount_minor: 20000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:SoftwareServices",
					credit_account: "Assets:Business:Checking",
					account_mapping_key: "business:software",
					field_confidence_json: "{}",
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "software_services",
					}),
					raw_payload_json: "{}",
					created_at: "2025-04-02T00:00:00.000Z",
					updated_at: "2025-04-02T00:00:00.000Z",
				},
				{
					id: "ledger-business-ready-tax-license",
					canonical_key: "business-ready-tax-license",
					status: "ready",
					source_authority: "email",
					occurred_at: "2025-04-02",
					posted_at: null,
					cleared_at: null,
					description: "State license",
					counterparty: "State Agency",
					direction: "expense",
					amount_value: "75.00",
					amount_minor: 7500,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:TaxesAndLicenses",
					credit_account: "Assets:Business:Checking",
					account_mapping_key: "business:tax-license",
					field_confidence_json: "{}",
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "taxes",
						categorySecondary: "tax_notice",
					}),
					raw_payload_json: "{}",
					created_at: "2025-04-02T00:00:00.000Z",
					updated_at: "2025-04-02T00:00:00.000Z",
				},
				{
					id: "ledger-business-ready-estimated-tax",
					canonical_key: "business-ready-estimated-tax",
					status: "ready",
					source_authority: "email",
					occurred_at: "2025-04-02",
					posted_at: null,
					cleared_at: null,
					description: "Estimated income tax",
					counterparty: "IRS",
					direction: "expense",
					amount_value: "120.00",
					amount_minor: 12000,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Taxes",
					credit_account: "Assets:Business:Checking",
					account_mapping_key: "business:estimated-tax",
					field_confidence_json: "{}",
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "taxes",
						categorySecondary: "estimated_tax",
					}),
					raw_payload_json: "{}",
					created_at: "2025-04-02T00:00:00.000Z",
					updated_at: "2025-04-02T00:00:00.000Z",
				},
				{
					id: "ledger-business-review-software",
					canonical_key: "business-review-software",
					status: "review",
					source_authority: "email",
					occurred_at: "2025-04-03",
					posted_at: null,
					cleared_at: null,
					description: "Review Software",
					counterparty: "Vendor",
					direction: "expense",
					amount_value: "999.00",
					amount_minor: 99900,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: null,
					credit_account: null,
					account_mapping_key: null,
					field_confidence_json: "{}",
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "software_services",
					}),
					raw_payload_json: "{}",
					created_at: "2025-04-03T00:00:00.000Z",
					updated_at: "2025-04-03T00:00:00.000Z",
				},
			])
			.execute();

		const { generateTaxReportPackage } = await runtime.importFresh<
			typeof import("#/lib/tax-reporting")
		>("#/lib/tax-reporting");
		const outDir = join(runtime.root, "tax-report-schedule-c");
		await generateTaxReportPackage({
			reportRunId: "tax-run-schedule-c",
			reportKind: "business_quarter",
			year: 2025,
			quarter: 2,
			outDir,
		});

		const formValues = JSON.parse(
			readFileSync(join(outDir, "forms", "form-values.json"), "utf8"),
		);
		expect(formValues.forms.scheduleC.lines.grossReceipts).toMatchObject({
			amountMinor: 50000,
			ledgerEntryIds: ["ledger-business-ready-income"],
		});
		expect(formValues.forms.scheduleC.lines.otherExpenses).toMatchObject({
			amountMinor: 20000,
			ledgerEntryIds: ["ledger-business-ready-software"],
		});
		expect(formValues.forms.scheduleC.lines.taxesAndLicenses).toMatchObject({
			amountMinor: 7500,
			ledgerEntryIds: ["ledger-business-ready-tax-license"],
		});
		expect(
			formValues.forms.scheduleC.lines.otherExpenses.ledgerEntryIds,
		).not.toContain("ledger-business-review-software");
		expect(
			formValues.forms.scheduleC.lines.taxesAndLicenses.ledgerEntryIds,
		).not.toContain("ledger-business-ready-estimated-tax");
	});

	it("stores complete status for clean packages with ready accepted rows", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-personal-ready-donation",
				canonical_key: "personal-ready-donation",
				status: "ready",
				source_authority: "email",
				occurred_at: "2025-05-01",
				posted_at: null,
				cleared_at: null,
				description: "Donation",
				counterparty: "Charity",
				direction: "expense",
				amount_value: "50.00",
				amount_minor: 5000,
				currency: "USD",
				book: "personal",
				business_use_percent: null,
				debit_account: "Expenses:Personal:Donations",
				credit_account: "Assets:Personal:Checking",
				account_mapping_key: "personal:donations",
				field_confidence_json: "{}",
				ledger_metadata_json: JSON.stringify({
					categoryPrimary: "donations",
				}),
				raw_payload_json: "{}",
				created_at: "2025-05-01T00:00:00.000Z",
				updated_at: "2025-05-01T00:00:00.000Z",
			})
			.execute();

		const { generateTaxReportPackage } = await runtime.importFresh<
			typeof import("#/lib/tax-reporting")
		>("#/lib/tax-reporting");
		const outDir = join(runtime.root, "tax-report-complete");
		const result = await generateTaxReportPackage({
			reportRunId: "tax-run-complete",
			reportKind: "personal_annual",
			year: 2025,
			outDir,
		});
		const stored = await db
			.selectFrom("tax_report_runs")
			.select(["status", "manifest_json"])
			.where("id", "=", "tax-run-complete")
			.executeTakeFirstOrThrow();
		const manifest = JSON.parse(stored.manifest_json);

		expect(result.status).toBe("complete");
		expect(stored.status).toBe("complete");
		expect(manifest.readiness.blockers).toEqual([]);
		expect(manifest.snapshot).toMatchObject({
			ledgerRowCount: 1,
			periodLedgerRowCount: 1,
			acceptedLedgerRowCount: 1,
			reviewLedgerRowCount: 0,
			ledgerUpdatedAtMax: "2025-05-01T00:00:00.000Z",
			openJobsAtGeneration: [],
		});
	});
});
