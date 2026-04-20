import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { nowIso } from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { currentOrgId, runtimePaths } from "#/lib/runtime";

type TaxReportKind = "personal_annual" | "business_quarter";

interface GenerateTaxPackageInput {
	reportRunId?: string;
	reportKind: TaxReportKind;
	year: number;
	quarter?: number | null;
	businessSlug?: string | null;
	outDir?: string | null;
}

interface LedgerRow {
	id: string;
	canonical_key: string;
	status: string;
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
	account_mapping_key: string | null;
	debit_account: string | null;
	credit_account: string | null;
	field_confidence_json: string;
	ledger_metadata_json: string;
}

function packageRoot(input: {
	orgId: string;
	reportRunId: string;
	reportKind: TaxReportKind;
	year: number;
	quarter?: number | null;
	outDir?: string | null;
}) {
	if (input.outDir?.trim()) {
		return resolve(input.outDir.trim());
	}
	const suffix =
		input.reportKind === "business_quarter"
			? `${input.year}-q${String(input.quarter ?? 1)}`
			: String(input.year);
	return resolve(
		runtimePaths(input.orgId).operatorDir,
		"reports",
		"tax",
		input.reportKind,
		suffix,
		input.reportRunId,
	);
}

function ledgerDate(row: LedgerRow) {
	return (row.occurred_at ?? row.posted_at ?? row.cleared_at ?? "").slice(
		0,
		10,
	);
}

function quarterForDate(value: string) {
	const month = Number.parseInt(value.slice(5, 7), 10);
	if (!Number.isInteger(month) || month < 1 || month > 12) {
		return null;
	}
	return Math.floor((month - 1) / 3) + 1;
}

function amountMinor(row: LedgerRow) {
	if (row.amount_minor !== null) {
		return row.amount_minor;
	}
	if (!row.amount_value) {
		return 0;
	}
	const parsed = Number.parseFloat(row.amount_value.replace(/[^0-9.-]/g, ""));
	return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function signedAmountMinor(row: LedgerRow) {
	const amount = Math.abs(amountMinor(row));
	if (row.direction === "income") {
		return amount;
	}
	if (row.direction === "expense") {
		return -amount;
	}
	return 0;
}

function csvCell(value: unknown) {
	const text = value === null || value === undefined ? "" : String(value);
	if (/[",\n\r]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

function csv(headers: string[], rows: unknown[][]) {
	return [
		headers.join(","),
		...rows.map((row) => row.map(csvCell).join(",")),
		"",
	].join("\n");
}

function money(minor: number) {
	const sign = minor < 0 ? "-" : "";
	const absolute = Math.abs(minor);
	return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function inSelectedPeriod(
	row: LedgerRow,
	input: { year: number; quarter?: number | null },
) {
	const date = ledgerDate(row);
	if (!date.startsWith(String(input.year))) {
		return false;
	}
	if (!input.quarter) {
		return true;
	}
	return quarterForDate(date) === input.quarter;
}

function belongsToReport(row: LedgerRow, input: GenerateTaxPackageInput) {
	if (!inSelectedPeriod(row, input)) {
		return false;
	}
	if (input.reportKind === "business_quarter") {
		return row.book === "business" || row.book === "mixed";
	}
	return row.book === "personal" || row.book === "mixed";
}

function ledgerCsvRows(rows: LedgerRow[]) {
	return rows.map((row) => [
		row.id,
		row.canonical_key,
		row.status,
		ledgerDate(row),
		row.description,
		row.counterparty,
		row.direction,
		money(signedAmountMinor(row)),
		row.currency,
		row.book,
		row.business_use_percent,
		row.account_mapping_key,
		row.debit_account,
		row.credit_account,
	]);
}

function summarizeRows(rows: LedgerRow[]) {
	let incomeMinor = 0;
	let expenseMinor = 0;
	for (const row of rows) {
		const amount = Math.abs(amountMinor(row));
		if (row.direction === "income") {
			incomeMinor += amount;
		}
		if (row.direction === "expense") {
			expenseMinor += amount;
		}
	}
	return {
		count: rows.length,
		incomeMinor,
		expenseMinor,
		netMinor: incomeMinor - expenseMinor,
	};
}

function isAcceptedReportRow(row: LedgerRow) {
	return (
		row.status === "ready" &&
		(row.direction === "income" || row.direction === "expense") &&
		row.amount_value !== null &&
		row.currency !== null &&
		ledgerDate(row) !== "" &&
		row.counterparty !== null &&
		row.book !== "unknown" &&
		row.account_mapping_key !== null &&
		row.debit_account !== null &&
		row.credit_account !== null &&
		(row.book !== "mixed" || row.business_use_percent !== null)
	);
}

function renderWorkpaper(input: {
	title: string;
	reportKind: TaxReportKind;
	year: number;
	quarter?: number | null;
	acceptedSummary: ReturnType<typeof summarizeRows>;
	reviewRows: LedgerRow[];
}) {
	return [
		`# ${input.title}`,
		"",
		`Report kind: ${input.reportKind}`,
		`Year: ${input.year}`,
		...(input.quarter ? [`Quarter: Q${input.quarter}`] : []),
		"",
		"## Accepted Totals",
		"",
		"Accepted totals include only `ready` ledger rows.",
		"",
		`- accepted rows: ${input.acceptedSummary.count}`,
		`- income: ${money(input.acceptedSummary.incomeMinor)}`,
		`- expenses: ${money(input.acceptedSummary.expenseMinor)}`,
		`- net: ${money(input.acceptedSummary.netMinor)}`,
		"",
		"## Review Rows",
		"",
		`Rows needing review or blocked repair: ${input.reviewRows.length}`,
		"",
		input.acceptedSummary.count === 0
			? "No ready rows exist for this package. Use review.csv and evidence.csv as the audit work queue."
			: "Review rows are excluded from accepted totals.",
		"",
	].join("\n");
}

export async function generateTaxReportPackage(input: GenerateTaxPackageInput) {
	const orgId = currentOrgId();
	const reportRunId = input.reportRunId ?? randomUUID();
	const generatedAt = nowIso();
	const outDir = packageRoot({
		orgId,
		reportRunId,
		reportKind: input.reportKind,
		year: input.year,
		quarter: input.quarter,
		outDir: input.outDir,
	});
	const db = getDb();
	const ledgerRows = (
		await db
			.selectFrom("finance_ledger_entries")
			.selectAll()
			.orderBy("occurred_at", "asc")
			.orderBy("posted_at", "asc")
			.execute()
	).filter((row) => belongsToReport(row, input));
	const acceptedRows = ledgerRows.filter(isAcceptedReportRow);
	const reviewRows = ledgerRows.filter((row) => !isAcceptedReportRow(row));
	const sourceRows =
		ledgerRows.length === 0
			? []
			: await db
					.selectFrom("finance_ledger_entry_sources")
					.select([
						"ledger_entry_id",
						"source_kind",
						"message_id",
						"secondary_result_id",
						"import_run_id",
						"import_transaction_id",
						"import_document_id",
						"evidence_json",
					])
					.where(
						"ledger_entry_id",
						"in",
						ledgerRows.map((row) => row.id),
					)
					.execute();

	const acceptedSummary = summarizeRows(acceptedRows);
	const reviewSummary = summarizeRows(reviewRows);
	const status = acceptedRows.length === 0 ? "audit_only" : "complete";
	const validation = {
		acceptedTotalsUseReadyOnly: true,
		noReadyRows: acceptedRows.length === 0,
		reviewRowsExcludedFromAcceptedTotals: true,
		rawRfc822Included: false,
		fullAccountNumbersIncluded: false,
	};
	const manifest = {
		schemaVersion: "tax-report-package.v1",
		orgId,
		reportRunId,
		reportKind: input.reportKind,
		year: input.year,
		quarter: input.quarter ?? null,
		businessSlug: input.businessSlug ?? null,
		generatedAt,
		status,
		files: {
			summaryMarkdown: "summary.md",
			summaryJson: "summary.json",
			ledgerCsv: "ledger.csv",
			reviewCsv: "review.csv",
			evidenceCsv: "evidence.csv",
			personalWorkpaper: "forms/personal-tax-workpaper.md",
			businessWorkpaper: "forms/quarterly-business-workpaper.md",
		},
		acceptedSummary,
		reviewSummary,
		validation,
	};

	mkdirSync(resolve(outDir, "forms"), { recursive: true });
	writeFileSync(
		resolve(outDir, "summary.md"),
		renderWorkpaper({
			title:
				input.reportKind === "business_quarter"
					? "Quarterly Business Workpaper"
					: "Personal Tax Workpaper",
			reportKind: input.reportKind,
			year: input.year,
			quarter: input.quarter,
			acceptedSummary,
			reviewRows,
		}),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "summary.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	const ledgerHeaders = [
		"id",
		"canonical_key",
		"status",
		"date",
		"description",
		"counterparty",
		"direction",
		"signed_amount",
		"currency",
		"book",
		"business_use_percent",
		"account_mapping_key",
		"debit_account",
		"credit_account",
	];
	writeFileSync(
		resolve(outDir, "ledger.csv"),
		csv(ledgerHeaders, ledgerCsvRows(acceptedRows)),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "review.csv"),
		csv(ledgerHeaders, ledgerCsvRows(reviewRows)),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "evidence.csv"),
		csv(
			[
				"ledger_entry_id",
				"source_kind",
				"message_id",
				"secondary_result_id",
				"import_run_id",
				"import_transaction_id",
				"import_document_id",
				"evidence_keys",
			],
			sourceRows.map((row) => [
				row.ledger_entry_id,
				row.source_kind,
				row.message_id,
				row.secondary_result_id,
				row.import_run_id,
				row.import_transaction_id,
				row.import_document_id,
				Object.keys(safeJsonParse(row.evidence_json, {})).join(";"),
			]),
		),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "forms", "personal-tax-workpaper.md"),
		renderWorkpaper({
			title: "Personal Tax Workpaper",
			reportKind: input.reportKind,
			year: input.year,
			quarter: input.quarter,
			acceptedSummary,
			reviewRows,
		}),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "forms", "quarterly-business-workpaper.md"),
		renderWorkpaper({
			title: "Quarterly Business Workpaper",
			reportKind: input.reportKind,
			year: input.year,
			quarter: input.quarter,
			acceptedSummary,
			reviewRows,
		}),
		"utf8",
	);

	await db
		.insertInto("tax_report_runs")
		.values({
			id: reportRunId,
			status,
			report_kind: input.reportKind,
			year: input.year,
			quarter: input.quarter ?? null,
			business_slug: input.businessSlug ?? null,
			out_dir: outDir,
			manifest_json: jsonText(manifest),
			validation_json: jsonText(validation),
			created_at: generatedAt,
			completed_at: nowIso(),
		})
		.onConflict((oc) =>
			oc.column("id").doUpdateSet({
				status,
				out_dir: outDir,
				manifest_json: jsonText(manifest),
				validation_json: jsonText(validation),
				completed_at: nowIso(),
			}),
		)
		.execute();

	return {
		reportRunId,
		status,
		outDir,
		manifest,
		acceptedRows: acceptedRows.length,
		reviewRows: reviewRows.length,
	};
}
