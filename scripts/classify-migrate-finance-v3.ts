import { randomUUID } from "node:crypto";

import {
	APP_CONFIG,
	ensureStorageDirs,
	FINANCE_MODEL_TARGET_PROMPT_VERSIONS,
	nowIso,
} from "#/lib/config";
import {
	defaultMigrationTargetOrgIds,
	ensureAccountOwnershipBackfill,
	getSqlite,
	runMigrations,
} from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import type { LogTrace } from "#/lib/log";
import { runWithOrgContext } from "#/lib/runtime";
import { runCli } from "#/scripts/_shared";

interface ParsedArgs {
	allOrgs: boolean;
	archive: boolean;
	clean: boolean;
	confirm: boolean;
	confirmClean: boolean;
	dryRun: boolean;
	reclassify: boolean;
	orgId?: string;
}

const ARCHIVE_SELECTS = [
	{
		table: "classification_results",
		where: "schema_version in ('message-label.v1', 'message-label.v2')",
	},
	{
		table: "message_labels",
		where: "schema_version in ('message-label.v1', 'message-label.v2')",
	},
	{
		table: "reviews",
		where:
			"message_id in (select message_id from message_labels where schema_version in ('message-label.v1', 'message-label.v2'))",
	},
	{
		table: "message_secondary_results",
		where:
			"classifier_key = 'finance_intel' and schema_version in ('finance-intel.v1', 'finance-intel.v2')",
	},
	{
		table: "message_secondary_heads",
		where: "classifier_key = 'finance_intel'",
	},
	{ table: "message_category_assignments", where: "1 = 1" },
	{ table: "message_category_assignment_heads", where: "1 = 1" },
	{ table: "finance_event_evidence", where: "1 = 1" },
	{ table: "finance_event_candidates", where: "1 = 1" },
	{ table: "finance_document_candidates", where: "1 = 1" },
	{ table: "finance_yearly_subcategory_rollups", where: "1 = 1" },
	{ table: "finance_yearly_rollups", where: "1 = 1" },
	{ table: "finance_export_items", where: "1 = 1" },
	{ table: "finance_export_runs", where: "1 = 1" },
	{ table: "finance_ledger_entry_sources", where: "1 = 1" },
	{ table: "finance_ledger_entries", where: "1 = 1" },
	{ table: "finance_patterns", where: "1 = 1" },
] as const;

const DELETE_ORDER = [
	"reviews",
	"message_category_assignment_heads",
	"message_category_assignments",
	"finance_export_items",
	"finance_export_runs",
	"finance_ledger_entry_sources",
	"finance_ledger_entries",
	"finance_patterns",
	"finance_event_evidence",
	"finance_event_candidates",
	"finance_document_candidates",
	"finance_yearly_subcategory_rollups",
	"finance_yearly_rollups",
	"message_secondary_heads",
	"message_secondary_results",
	"message_labels",
	"classification_results",
] as const;

export function parseClassifyMigrateFinanceV3Args(
	argv = process.argv,
): ParsedArgs {
	const args = argv.slice(2);
	let allOrgs = false;
	let archive = false;
	let clean = false;
	let confirm = false;
	let confirmClean = false;
	let dryRun = false;
	let reclassify = false;
	let orgId: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			continue;
		}
		switch (arg) {
			case "--all-orgs":
				allOrgs = true;
				break;
			case "--archive":
				archive = true;
				break;
			case "--clean":
				clean = true;
				break;
			case "--confirm":
				confirm = true;
				break;
			case "--confirm-clean":
				confirmClean = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--reclassify":
				reclassify = true;
				break;
			case "--org": {
				const value = args[index + 1]?.trim();
				if (!value) {
					throw new Error("Missing value for --org");
				}
				orgId = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unsupported classify:migrate-finance-v3 arg: ${arg}`);
		}
	}

	if (orgId && allOrgs) {
		throw new Error(
			"classify:migrate-finance-v3 accepts either --org <orgId> or --all-orgs",
		);
	}
	if (!orgId && !allOrgs) {
		throw new Error(
			"classify:migrate-finance-v3 requires --org <orgId> or --all-orgs",
		);
	}
	if (!dryRun && !confirm) {
		throw new Error(
			"classify:migrate-finance-v3 mutates classification state; pass --dry-run or --confirm",
		);
	}
	if (clean && !confirmClean) {
		throw new Error(
			"classify:migrate-finance-v3 --clean requires --confirm-clean",
		);
	}
	if (!dryRun && !archive && !clean) {
		throw new Error(
			"classify:migrate-finance-v3 requires --archive or --clean for confirmed migrations",
		);
	}

	return {
		allOrgs,
		archive,
		clean,
		confirm,
		confirmClean,
		dryRun,
		reclassify,
		orgId,
	};
}

function countRows(table: string, where: string) {
	const sqlite = getSqlite();
	return Number(
		(
			sqlite
				.prepare(`select count(*) as count from ${table} where ${where}`)
				.get() as { count: number }
		).count,
	);
}

function archiveSourcePk(row: Record<string, unknown>) {
	for (const key of [
		"id",
		"message_id",
		"key",
		"canonical_key",
		"export_run_id",
	]) {
		const value = row[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
		if (typeof value === "number") {
			return String(value);
		}
	}
	return null;
}

function archiveAndClear(input: {
	archiveRunId: string;
	archivedAt: string;
	dryRun: boolean;
	orgId: string;
	options: ParsedArgs;
}) {
	const counts = ARCHIVE_SELECTS.map((entry) => ({
		table: entry.table,
		rows: countRows(entry.table, entry.where),
	}));
	if (input.dryRun) {
		return counts;
	}

	const sqlite = getSqlite();
	sqlite.transaction(() => {
		sqlite
			.prepare(
				`insert into finance_model_migration_runs (
					id,
					org_id,
					status,
					archived_at,
					options_json,
					counts_json
				) values (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.archiveRunId,
				input.orgId,
				input.options.reclassify ? "reclassify_queued" : "archived",
				input.archivedAt,
				JSON.stringify({
					archive: input.options.archive,
					reclassify: input.options.reclassify,
					clean: input.options.clean,
				}),
				JSON.stringify(counts),
			);

		const insertArchiveRow = sqlite.prepare(
			`insert into finance_v3_archive_rows (
				id,
				archive_run_id,
				org_id,
				source_table,
				source_pk,
				payload_json,
				archived_at
			) values (?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const entry of ARCHIVE_SELECTS) {
			const rows = sqlite
				.prepare(
					`select rowid as __rowid, * from ${entry.table} where ${entry.where}`,
				)
				.all() as Array<Record<string, unknown>>;
			for (const row of rows) {
				const { __rowid, ...payload } = row;
				insertArchiveRow.run(
					randomUUID(),
					input.archiveRunId,
					input.orgId,
					entry.table,
					archiveSourcePk(payload) ?? String(__rowid ?? ""),
					JSON.stringify(payload),
					input.archivedAt,
				);
			}
		}

		for (const table of DELETE_ORDER) {
			const entry = ARCHIVE_SELECTS.find(
				(candidate) => candidate.table === table,
			);
			if (!entry) {
				continue;
			}
			sqlite.prepare(`delete from ${table} where ${entry.where}`).run();
		}
	})();

	return counts;
}

function cleanArchivedRows(input: { dryRun: boolean; orgId: string }) {
	const sqlite = getSqlite();
	const archiveRows = Number(
		(
			sqlite
				.prepare(
					"select count(*) as count from finance_v3_archive_rows where org_id = ?",
				)
				.get(input.orgId) as { count: number }
		).count,
	);
	const runs = Number(
		(
			sqlite
				.prepare(
					"select count(*) as count from finance_model_migration_runs where org_id = ? and cleaned_at is null",
				)
				.get(input.orgId) as { count: number }
		).count,
	);
	if (input.dryRun) {
		return { archiveRows, runs };
	}
	const cleanedAt = nowIso();
	sqlite.transaction(() => {
		sqlite
			.prepare("delete from finance_v3_archive_rows where org_id = ?")
			.run(input.orgId);
		sqlite
			.prepare(
				"update finance_model_migration_runs set cleaned_at = ? where org_id = ? and cleaned_at is null",
			)
			.run(cleanedAt, input.orgId);
	})();
	return { archiveRows, runs, cleanedAt };
}

async function queueReclassification() {
	const sqlite = getSqlite();
	const accounts = sqlite
		.prepare("select id from accounts order by id")
		.all() as Array<{ id: string }>;
	for (const account of accounts) {
		await queueJobIdempotent({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: account.id,
			model: APP_CONFIG.classifierModel,
			promptVersion: FINANCE_MODEL_TARGET_PROMPT_VERSIONS.classify,
			meta: { targetSchemaVersion: "message-label.v3" },
		});
		await queueJobIdempotent({
			kind: "classify_finance_backlog",
			scopeType: "account",
			scopeId: account.id,
			model: APP_CONFIG.classifierModel,
			promptVersion: FINANCE_MODEL_TARGET_PROMPT_VERSIONS.financeIntel,
			meta: { targetSchemaVersion: "finance-intel.v3" },
		});
	}
	return accounts.length;
}

function targetOrgIds(args: ParsedArgs) {
	return args.orgId ? [args.orgId] : defaultMigrationTargetOrgIds();
}

export async function main(_trace?: LogTrace, argv = process.argv) {
	ensureStorageDirs();
	const args = parseClassifyMigrateFinanceV3Args(argv);
	const results = [];

	for (const orgId of targetOrgIds(args)) {
		const result = await runWithOrgContext(orgId, async () => {
			runMigrations(orgId);
			await ensureAccountOwnershipBackfill(orgId);

			const archiveRunId = randomUUID();
			const archivedAt = nowIso();
			const counts = args.archive
				? archiveAndClear({
						archiveRunId,
						archivedAt,
						dryRun: args.dryRun,
						orgId,
						options: args,
					})
				: [];
			const queuedAccounts =
				args.reclassify && !args.dryRun ? await queueReclassification() : 0;
			const clean = args.clean
				? cleanArchivedRows({ dryRun: args.dryRun, orgId })
				: null;
			return {
				orgId,
				archiveRunId,
				archivedAt,
				dryRun: args.dryRun,
				archive: args.archive,
				reclassify: args.reclassify,
				clean: args.clean,
				counts,
				queuedAccounts,
				cleanResult: clean,
			};
		});
		results.push(result);
	}

	process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

runCli(main, import.meta.url, "classify:migrate-finance-v3");
