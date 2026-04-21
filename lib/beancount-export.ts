import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { nowIso } from "#/lib/config";
import { getDb, jsonText } from "#/lib/db";
import { financeLedgerExportSchema } from "#/lib/schemas";

interface ExportInput {
	orgId: string;
	outDir: string;
	exportRunId?: string;
	year?: number;
	strict: boolean;
	force?: boolean;
}

interface LedgerRow {
	id: string;
	canonical_key: string;
	status: string;
	source_authority: string;
	occurred_at: string | null;
	posted_at: string | null;
	cleared_at: string | null;
	description: string | null;
	counterparty: string | null;
	direction: string;
	amount_value: string | null;
	amount_minor: number | null;
	currency: string | null;
	book: string;
	business_use_percent: number | null;
	debit_account: string | null;
	credit_account: string | null;
	account_mapping_key: string | null;
	field_confidence_json: string;
	ledger_metadata_json: string;
	raw_payload_json: string;
}

interface SourceRow {
	ledger_entry_id: string | null;
	source_kind: string;
	message_id: string | null;
	import_run_id: string | null;
	import_transaction_id: string | null;
	import_document_id: string | null;
}

function quote(value: string) {
	return JSON.stringify(value);
}

function beancountDate(row: LedgerRow) {
	return (row.occurred_at ?? row.posted_at ?? row.cleared_at ?? "").slice(
		0,
		10,
	);
}

function parseMinorAmount(row: LedgerRow) {
	if (row.amount_minor !== null) {
		return row.amount_minor;
	}
	if (!row.amount_value) {
		return null;
	}
	const normalized = row.amount_value.replace(/[^0-9.-]/g, "").trim();
	if (!normalized) {
		return null;
	}
	const value = Number.parseFloat(normalized);
	return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function formatMinorAmount(minor: number) {
	const sign = minor < 0 ? "-" : "";
	const absolute = Math.abs(minor);
	const whole = Math.floor(absolute / 100);
	const cents = String(absolute % 100).padStart(2, "0");
	return `${sign}${whole}.${cents}`;
}

function sanitizeBeancountLinkPart(value: string) {
	const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return normalized.replace(/^-+|-+$/g, "").slice(0, 160) || "unknown";
}

function validAccountName(value: string | null) {
	if (!value) {
		return false;
	}
	return /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z][A-Za-z0-9_-]*)+$/.test(
		value,
	);
}

function csvCell(value: unknown) {
	const text = value === null || value === undefined ? "" : String(value);
	if (/[",\n\r]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

function isExportable(row: LedgerRow) {
	const date = beancountDate(row);
	const amountMinor = parseMinorAmount(row);
	const currency = row.currency?.trim();
	if (row.status !== "ready") {
		return { ok: false as const, reason: `status=${row.status}` };
	}
	if (!date) {
		return { ok: false as const, reason: "missing_date" };
	}
	if (amountMinor === null || amountMinor === 0) {
		return { ok: false as const, reason: "missing_amount" };
	}
	if (!currency) {
		return { ok: false as const, reason: "missing_currency" };
	}
	if (row.direction !== "income" && row.direction !== "expense") {
		return { ok: false as const, reason: `direction=${row.direction}` };
	}
	if (!validAccountName(row.debit_account)) {
		return { ok: false as const, reason: "missing_debit_account" };
	}
	if (!validAccountName(row.credit_account)) {
		return { ok: false as const, reason: "missing_credit_account" };
	}
	if (row.book === "mixed" && row.business_use_percent === null) {
		return { ok: false as const, reason: "missing_business_use_percent" };
	}
	return { ok: true as const, date, amountMinor, currency };
}

function renderTransaction(input: {
	row: LedgerRow;
	source: SourceRow | undefined;
	exportRunId: string;
}) {
	const exportable = isExportable(input.row);
	if (!exportable.ok) {
		throw new Error(`Ledger row is not exportable: ${input.row.id}`);
	}

	const payee = input.row.counterparty ?? input.row.description ?? "Unknown";
	const narration = input.row.description ?? input.row.direction;
	const link = `^zmail-${sanitizeBeancountLinkPart(input.row.canonical_key)}`;
	const amount = formatMinorAmount(Math.abs(exportable.amountMinor));
	const oppositeAmount = formatMinorAmount(-Math.abs(exportable.amountMinor));
	const source = input.source?.source_kind ?? input.row.source_authority;
	const metadata = [
		`  zmail_book: ${quote(input.row.book)}`,
		`  zmail_confidence: ${quote(input.row.field_confidence_json)}`,
		`  zmail_source: ${quote(source)}`,
		`  zmail_canonical_key: ${quote(input.row.canonical_key)}`,
		...(input.source?.message_id
			? [`  zmail_message_id: ${quote(input.source.message_id)}`]
			: []),
		`  zmail_export_run_id: ${quote(input.exportRunId)}`,
	];

	return [
		`${exportable.date} * ${quote(payee)} ${quote(narration)} ${link}`,
		...metadata,
		`  ${input.row.debit_account}  ${amount} ${exportable.currency}`,
		`  ${input.row.credit_account}  ${oppositeAmount} ${exportable.currency}`,
		"",
	].join("\n");
}

function renderAccounts(entries: LedgerRow[], date: string) {
	const accounts = Array.from(
		new Set(
			entries.flatMap((entry) => [
				entry.debit_account ?? "",
				entry.credit_account ?? "",
			]),
		),
	)
		.filter((account) => validAccountName(account))
		.sort();

	if (accounts.length === 0) {
		return [
			"; zmail generated accounts",
			`${date} open Assets:Personal:Opening-Balances`,
			`${date} open Equity:Opening-Balances`,
			"",
		].join("\n");
	}

	return [
		"; zmail generated accounts",
		...accounts.map((account) => `${date} open ${account}`),
		"",
	].join("\n");
}

function exportableCurrencies(entries: LedgerRow[]) {
	const currencies = entries
		.map((entry) => entry.currency?.trim())
		.filter((currency): currency is string => Boolean(currency));
	return Array.from(new Set(currencies)).sort();
}

function renderMain(generatedFile: string, currencies: string[]) {
	const operatingCurrencies = currencies.length > 0 ? currencies : ["USD"];
	return [
		'option "title" "zmail Finance Export"',
		...operatingCurrencies.map(
			(currency) => `option "operating_currency" ${quote(currency)}`,
		),
		'include "accounts.beancount"',
		`include "${generatedFile}"`,
		"",
	].join("\n");
}

function unresolvedCsv(rows: Array<{ row: LedgerRow; reason: string }>) {
	const header = [
		"canonical_key",
		"status",
		"reason",
		"date",
		"amount",
		"currency",
		"counterparty",
		"book",
	].join(",");
	const body = rows.map(({ row, reason }) =>
		[
			row.canonical_key,
			row.status,
			reason,
			beancountDate(row),
			row.amount_value,
			row.currency,
			row.counterparty,
			row.book,
		]
			.map(csvCell)
			.join(","),
	);
	return [header, ...body, ""].join("\n");
}

function yearMatches(row: LedgerRow, year: number) {
	return beancountDate(row).startsWith(String(year));
}

function runBeanCheck(mainPath: string) {
	const result = spawnSync("bean-check", [mainPath], {
		encoding: "utf8",
	});
	if (
		result.error &&
		"code" in result.error &&
		result.error.code === "ENOENT"
	) {
		return { status: "skipped" as const, output: "bean-check not installed" };
	}
	const output = [result.stdout, result.stderr]
		.filter(Boolean)
		.join("\n")
		.trim();
	return {
		status: result.status === 0 ? ("passed" as const) : ("failed" as const),
		output: output || null,
	};
}

export async function exportFinanceBeancountPackage(input: ExportInput) {
	const db = getDb(input.orgId);
	const exportRunId = input.exportRunId ?? randomUUID();
	const generatedAt = nowIso();
	const year = input.year ?? new Date(generatedAt).getUTCFullYear();
	const outDir = resolve(input.outDir);
	const generatedName = `generated/${year}.beancount`;
	if (existsSync(outDir) && !input.force) {
		throw new Error(
			`Export target already exists: ${outDir}. Pass --force to overwrite it.`,
		);
	}

	const rows = (
		await db
			.selectFrom("finance_ledger_entries")
			.selectAll()
			.orderBy("occurred_at", "asc")
			.orderBy("posted_at", "asc")
			.execute()
	).filter((row) => yearMatches(row, year));
	const sourceRows = await db
		.selectFrom("finance_ledger_entry_sources")
		.selectAll()
		.execute();
	const sourcesByEntry = new Map<string, SourceRow>();
	for (const source of sourceRows) {
		if (source.ledger_entry_id && !sourcesByEntry.has(source.ledger_entry_id)) {
			sourcesByEntry.set(source.ledger_entry_id, source);
		}
	}

	const exportable: LedgerRow[] = [];
	const unresolved: Array<{ row: LedgerRow; reason: string }> = [];
	for (const row of rows) {
		const readiness = isExportable(row);
		if (readiness.ok) {
			exportable.push(row);
		} else {
			unresolved.push({ row, reason: readiness.reason });
		}
	}

	mkdirSync(resolve(outDir, "generated"), { recursive: true });
	mkdirSync(resolve(outDir, "raw"), { recursive: true });
	mkdirSync(resolve(outDir, "review"), { recursive: true });
	mkdirSync(resolve(outDir, "documents"), { recursive: true });

	const generatedBody =
		exportable
			.map((row) =>
				renderTransaction({
					row,
					source: sourcesByEntry.get(row.id),
					exportRunId,
				}),
			)
			.join("\n") || "; no exportable zmail finance ledger entries\n";
	const accountsBody = renderAccounts(exportable, `${year}-01-01`);
	const mainBody = renderMain(generatedName, exportableCurrencies(exportable));

	const mainPath = resolve(outDir, "main.beancount");
	const accountsPath = resolve(outDir, "accounts.beancount");
	const generatedPath = resolve(outDir, generatedName);
	const rawPath = resolve(outDir, "raw", "zmail-finance-export.json");
	const unresolvedPath = resolve(outDir, "review", "unresolved.csv");

	writeFileSync(accountsPath, accountsBody, "utf8");
	writeFileSync(generatedPath, generatedBody, "utf8");
	writeFileSync(mainPath, mainBody, "utf8");
	writeFileSync(unresolvedPath, unresolvedCsv(unresolved), "utf8");

	const validation = existsSync(mainPath)
		? runBeanCheck(mainPath)
		: { status: "failed" as const, output: "main.beancount missing" };

	const packageJson = financeLedgerExportSchema.parse({
		schemaVersion: "finance-ledger-export.v1",
		orgId: input.orgId,
		exportRunId,
		generatedAt,
		strict: input.strict,
		year,
		files: {
			main: basename(mainPath),
			accounts: basename(accountsPath),
			generated: [generatedName],
			raw: "raw/zmail-finance-export.json",
			unresolved: "review/unresolved.csv",
			documents: [],
		},
		items: [
			...exportable.map((row) => ({
				canonicalKey: row.canonical_key,
				status: "exported",
				sourceKind: "ledger_entry",
				beancountLink: `zmail-${sanitizeBeancountLinkPart(row.canonical_key)}`,
				messageId: sourcesByEntry.get(row.id)?.message_id ?? null,
				sourceImportId: sourcesByEntry.get(row.id)?.import_run_id ?? null,
				reason: null,
			})),
			...unresolved.map(({ row, reason }) => ({
				canonicalKey: row.canonical_key,
				status: "unresolved",
				sourceKind: "raw_sidecar",
				beancountLink: null,
				messageId: sourcesByEntry.get(row.id)?.message_id ?? null,
				sourceImportId: sourcesByEntry.get(row.id)?.import_run_id ?? null,
				reason,
			})),
		],
		unresolvedRows: unresolved.map(({ row, reason }) => ({
			reason,
			row,
		})),
		validation: {
			beanCheck: validation.status,
			beanCheckOutput: validation.output,
			favaSmoke: "manual",
		},
	});

	writeFileSync(rawPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("finance_export_runs")
			.values({
				id: exportRunId,
				status:
					validation.status === "failed" ? "validation_failed" : "complete",
				strict: input.strict ? 1 : 0,
				year,
				out_dir: outDir,
				package_json: jsonText(packageJson),
				validation_json: jsonText(packageJson.validation),
				created_at: generatedAt,
				completed_at: nowIso(),
			})
			.onConflict((oc) =>
				oc.column("id").doUpdateSet({
					status:
						validation.status === "failed" ? "validation_failed" : "complete",
					strict: input.strict ? 1 : 0,
					year,
					out_dir: outDir,
					package_json: jsonText(packageJson),
					validation_json: jsonText(packageJson.validation),
					completed_at: nowIso(),
				}),
			)
			.execute();

		const items = packageJson.items.map((item) => ({
			id: randomUUID(),
			export_run_id: exportRunId,
			ledger_entry_id:
				exportable.find((row) => row.canonical_key === item.canonicalKey)?.id ??
				null,
			canonical_key: item.canonicalKey,
			status: item.status,
			beancount_link: item.beancountLink,
			sidecar_reason: item.reason,
			payload_json: jsonText(item),
			created_at: generatedAt,
		}));
		if (items.length > 0) {
			await trx.insertInto("finance_export_items").values(items).execute();
		}
	});

	return {
		exportRunId,
		outDir,
		mainPath,
		accountsPath,
		generatedPath,
		rawPath,
		unresolvedPath,
		exported: exportable.length,
		unresolved: unresolved.length,
		validation: packageJson.validation,
	};
}
