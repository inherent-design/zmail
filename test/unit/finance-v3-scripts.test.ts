import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parseClassifyMigrateFinanceV3Args } from "#/scripts/classify-migrate-finance-v3";
import { parseFinanceExportArgs } from "#/scripts/export-finance-beancount";
import { parseFinanceLedgerDateRepairArgs } from "#/scripts/repair-finance-ledger-dates";
import {
	bootDb,
	insertMessageRow,
	insertMessageSourceRow,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

type TestDb = Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>;

async function seedRepairCandidate(
	db: TestDb,
	input?: {
		entryId?: string;
		canonicalKey?: string;
		occurredAt?: string | null;
		occurredAtPrecision?: string;
		postedAt?: string | null;
		postedAtPrecision?: string;
		receivedAt?: string | null;
	},
) {
	const messageId = await insertMessageRow(db, {
		id: `message-${input?.entryId ?? "repair"}`,
		accountId: "acct-1",
		receivedAt: input?.receivedAt ?? "2026-02-01T06:45:35.000Z",
		contentSha256: `${input?.entryId ?? "repair"}-sha`,
	});
	await insertMessageSourceRow(db, {
		messageId,
		accountId: "acct-1",
		remoteMessageId: `remote-${input?.entryId ?? "repair"}`,
		remoteThreadId: `thread-${input?.entryId ?? "repair"}`,
		rawRfc822Path: null,
	});
	const entryId = input?.entryId ?? "ledger-repair";
	await db
		.insertInto("finance_ledger_entries")
		.values({
			id: entryId,
			canonical_key:
				input?.canonicalKey ??
				"composite:business|acct:checking|2026-01|42-00|USD|digitalocean",
			status: "ready",
			source_authority: "email",
			occurred_at: input?.occurredAt ?? "2026-01",
			occurred_at_precision: input?.occurredAtPrecision ?? "month",
			posted_at: input?.postedAt ?? null,
			posted_at_precision: input?.postedAtPrecision ?? "unknown",
			cleared_at: null,
			cleared_at_precision: "unknown",
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
			field_confidence_json: "{}",
			ledger_metadata_json: JSON.stringify({
				financialAccountId: "acct:checking",
			}),
			raw_payload_json: "{}",
			created_at: "2026-02-01T00:00:00.000Z",
			updated_at: "2026-02-01T00:00:00.000Z",
		})
		.execute();
	await db
		.insertInto("finance_ledger_entry_sources")
		.values({
			id: `ledger-source-${entryId}`,
			ledger_entry_id: entryId,
			source_kind: "email",
			message_id: messageId,
			secondary_result_id: null,
			import_run_id: null,
			import_transaction_id: null,
			import_document_id: null,
			evidence_json: "{}",
			created_at: "2026-02-01T00:00:00.000Z",
		})
		.execute();
	return { messageId, entryId };
}

describe("finance v3 scripts", () => {
	it("parses finance export args", () => {
		expect(
			parseFinanceExportArgs([
				"node",
				"script",
				"--org",
				"org_1",
				"--out",
				"/tmp/export",
				"--year",
				"2026",
				"--strict",
				"--force",
			]),
		).toEqual({
			orgId: "org_1",
			outDir: "/tmp/export",
			year: 2026,
			strict: true,
			force: true,
		});

		expect(() =>
			parseFinanceExportArgs(["node", "script", "--org", "org_1"]),
		).toThrow("finance:export requires");
	});

	it("parses finance v3 migration args with safety gates", () => {
		expect(
			parseClassifyMigrateFinanceV3Args([
				"node",
				"script",
				"--org",
				"org_1",
				"--archive",
				"--reclassify",
				"--dry-run",
			]),
		).toMatchObject({
			orgId: "org_1",
			archive: true,
			reclassify: true,
			dryRun: true,
		});

		expect(() =>
			parseClassifyMigrateFinanceV3Args([
				"node",
				"script",
				"--org",
				"org_1",
				"--archive",
			]),
		).toThrow("pass --dry-run or --confirm");

		expect(() =>
			parseClassifyMigrateFinanceV3Args([
				"node",
				"script",
				"--org",
				"org_1",
				"--all-orgs",
				"--dry-run",
			]),
		).toThrow("either --org <orgId> or --all-orgs");
	});

	it("parses finance ledger date repair args with safety gates", () => {
		expect(
			parseFinanceLedgerDateRepairArgs([
				"node",
				"script",
				"--org",
				"org_1",
				"--dry-run",
			]),
		).toEqual({
			orgId: "org_1",
			allOrgs: false,
			confirm: false,
			dryRun: true,
		});

		expect(() =>
			parseFinanceLedgerDateRepairArgs(["node", "script", "--org", "org_1"]),
		).toThrow("requires exactly one of --dry-run or --confirm");

		expect(() =>
			parseFinanceLedgerDateRepairArgs([
				"node",
				"script",
				"--org",
				"org_1",
				"--all-orgs",
				"--dry-run",
			]),
		).toThrow("either --org <orgId> or --all-orgs");
	});

	it("keeps repair rows unchanged during dry-run", async () => {
		const runtime = await createTestRuntime();
		const { repairFinanceLedgerDatesForOrg } = await runtime.importFresh<
			typeof import("#/scripts/repair-finance-ledger-dates")
		>("#/scripts/repair-finance-ledger-dates");
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedRepairCandidate(db);
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);

		const result = await repairFinanceLedgerDatesForOrg({
			orgId: currentOrgId(),
			confirm: false,
			dryRun: true,
			runLabel: "2026-04-23T00-00-00-000Z",
		});

		const row = await db
			.selectFrom("finance_ledger_entries")
			.select(["canonical_key", "posted_at", "posted_at_precision"])
			.where("id", "=", "ledger-repair")
			.executeTakeFirstOrThrow();

		expect(result).toMatchObject({
			candidates: 1,
			recoverable: 1,
			collisions: 0,
			skipped: 0,
			updated: 0,
			backupPath: null,
		});
		expect(row).toMatchObject({
			canonical_key:
				"composite:business|acct:checking|2026-01|42-00|USD|digitalocean",
			posted_at: null,
			posted_at_precision: "unknown",
		});
		expect(existsSync(result.manifestPath)).toBe(true);
	});

	it("repairs safe rows in confirm mode and writes a backup", async () => {
		const runtime = await createTestRuntime();
		const { repairFinanceLedgerDatesForOrg } = await runtime.importFresh<
			typeof import("#/scripts/repair-finance-ledger-dates")
		>("#/scripts/repair-finance-ledger-dates");
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedRepairCandidate(db);
		await db
			.insertInto("finance_ledger_entry_overrides")
			.values({
				id: "override-repair",
				canonical_key:
					"composite:business|acct:checking|2026-01|42-00|USD|digitalocean",
				patch_json: "{}",
				relationship_patch_json: "{}",
				note: null,
				actor_ref: "test",
				status: "active",
				created_at: "2026-02-01T00:00:00.000Z",
				updated_at: "2026-02-01T00:00:00.000Z",
				superseded_at: null,
			})
			.execute();
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);

		const result = await repairFinanceLedgerDatesForOrg({
			orgId: currentOrgId(),
			confirm: true,
			dryRun: false,
			runLabel: "2026-04-23T00-00-00-000Z",
		});

		const row = await db
			.selectFrom("finance_ledger_entries")
			.select([
				"canonical_key",
				"occurred_at",
				"posted_at",
				"posted_at_precision",
				"ledger_metadata_json",
			])
			.where("id", "=", "ledger-repair")
			.executeTakeFirstOrThrow();
		const override = await db
			.selectFrom("finance_ledger_entry_overrides")
			.select(["canonical_key"])
			.where("id", "=", "override-repair")
			.executeTakeFirstOrThrow();

		expect(result).toMatchObject({
			candidates: 1,
			recoverable: 1,
			collisions: 0,
			skipped: 0,
			updated: 1,
		});
		expect(result.backupPath).toBeTruthy();
		expect(existsSync(String(result.backupPath))).toBe(true);
		expect(existsSync(result.manifestPath)).toBe(true);
		expect(row).toMatchObject({
			canonical_key:
				"composite:business|acct:checking|2026-02-01|42-00|USD|digitalocean",
			occurred_at: "2026-01",
			posted_at: "2026-02-01T06:45:35.000Z",
			posted_at_precision: "datetime",
		});
		expect(JSON.parse(row.ledger_metadata_json)).toMatchObject({
			dateRecovery: {
				recoveredField: "posted_at",
				recoveredFrom: "message_received_at",
				originalPeriod: "2026-01",
			},
		});
		expect(override).toEqual({
			canonical_key:
				"composite:business|acct:checking|2026-02-01|42-00|USD|digitalocean",
		});
	});

	it("leaves colliding rows unchanged and reports the blocker", async () => {
		const runtime = await createTestRuntime();
		const { repairFinanceLedgerDatesForOrg } = await runtime.importFresh<
			typeof import("#/scripts/repair-finance-ledger-dates")
		>("#/scripts/repair-finance-ledger-dates");
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedRepairCandidate(db);
		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-existing-target",
				canonical_key:
					"composite:business|acct:checking|2026-02-01|42-00|USD|digitalocean",
				status: "ready",
				source_authority: "email",
				occurred_at: "2026-02-01",
				occurred_at_precision: "day",
				posted_at: null,
				posted_at_precision: "unknown",
				cleared_at: null,
				cleared_at_precision: "unknown",
				description: "Existing target",
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
				field_confidence_json: "{}",
				ledger_metadata_json: JSON.stringify({
					financialAccountId: "acct:checking",
				}),
				raw_payload_json: "{}",
				created_at: "2026-02-01T00:00:00.000Z",
				updated_at: "2026-02-01T00:00:00.000Z",
			})
			.execute();
		const { currentOrgId } =
			await runtime.importFresh<typeof import("#/lib/runtime")>(
				"#/lib/runtime",
			);

		const result = await repairFinanceLedgerDatesForOrg({
			orgId: currentOrgId(),
			confirm: true,
			dryRun: false,
			runLabel: "2026-04-23T00-00-00-000Z",
		});

		const row = await db
			.selectFrom("finance_ledger_entries")
			.select(["canonical_key", "posted_at"])
			.where("id", "=", "ledger-repair")
			.executeTakeFirstOrThrow();

		expect(result).toMatchObject({
			candidates: 1,
			recoverable: 0,
			collisions: 1,
			skipped: 1,
			updated: 0,
		});
		expect(result.plans[0]).toMatchObject({
			status: "collision",
			reason: "collision_existing_canonical_key",
		});
		expect(row).toEqual({
			canonical_key:
				"composite:business|acct:checking|2026-01|42-00|USD|digitalocean",
			posted_at: null,
		});
	});
});
