import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

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
		const unresolved = readFileSync(
			join(outDir, "review", "unresolved.csv"),
			"utf8",
		);
		expect(unresolved).toContain("email:review");
		const manifest = JSON.parse(
			readFileSync(join(outDir, "raw", "zmail-finance-export.json"), "utf8"),
		) as { validation: { beanCheck: string }; items: unknown[] };
		expect(["passed", "failed", "skipped"]).toContain(
			manifest.validation.beanCheck,
		);
		expect(manifest.items).toHaveLength(2);
	});
});
