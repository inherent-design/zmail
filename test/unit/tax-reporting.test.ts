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
		expect(summary.validation).toMatchObject({
			acceptedTotalsUseReadyOnly: true,
			noReadyRows: true,
			rawRfc822Included: false,
			fullAccountNumbersIncluded: false,
		});
	});
});
