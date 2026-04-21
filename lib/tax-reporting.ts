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

function maxIsoValue(values: Array<string | null>) {
	return values.reduce<string | null>((current, value) => {
		if (!value) {
			return current;
		}
		if (!current || value > current) {
			return value;
		}
		return current;
	}, null);
}

function rowMetadata(row: LedgerRow) {
	return safeJsonParse<{
		categoryPrimary?: string | null;
		categorySecondary?: string | null;
	}>(row.ledger_metadata_json, {});
}

function rowCategory(row: LedgerRow) {
	return rowMetadata(row).categoryPrimary ?? "uncategorized";
}

function rowSubcategory(row: LedgerRow) {
	return rowMetadata(row).categorySecondary ?? null;
}

function businessAmountMinor(row: LedgerRow) {
	const amount = Math.abs(amountMinor(row));
	if (row.book === "business") {
		return amount;
	}
	if (row.book === "mixed" && row.business_use_percent !== null) {
		return Math.round((amount * row.business_use_percent) / 100);
	}
	return 0;
}

function personalAmountMinor(row: LedgerRow) {
	const amount = Math.abs(amountMinor(row));
	if (row.book === "personal") {
		return amount;
	}
	if (row.book === "mixed" && row.business_use_percent !== null) {
		return Math.round((amount * (100 - row.business_use_percent)) / 100);
	}
	return 0;
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

function lineValue(
	rows: LedgerRow[],
	predicate: (row: LedgerRow) => boolean,
	amountForRow: (row: LedgerRow) => number,
) {
	const selected = rows.filter(predicate);
	return {
		amountMinor: selected.reduce((sum, row) => sum + amountForRow(row), 0),
		ledgerEntryIds: selected.map((row) => row.id),
	};
}

function openJobSummary(rows: Array<{ kind: string; status: string }>) {
	const counts = new Map<string, { queued: number; running: number }>();
	for (const row of rows) {
		const current = counts.get(row.kind) ?? { queued: 0, running: 0 };
		if (row.status === "queued") {
			current.queued += 1;
		}
		if (row.status === "running") {
			current.running += 1;
		}
		counts.set(row.kind, current);
	}
	return [...counts.entries()].map(([kind, count]) => ({ kind, ...count }));
}

function readinessForPackage(input: {
	periodRows: LedgerRow[];
	accountMappingCount: number;
	openJobs: Array<{ kind: string; status: string }>;
}) {
	const rows = input.periodRows.filter((row) => row.status !== "duplicate");
	const missing = {
		amount: rows.filter((row) => amountMinor(row) === 0 && !row.amount_value)
			.length,
		date: rows.filter((row) => ledgerDate(row) === "").length,
		counterparty: rows.filter((row) => !row.counterparty).length,
		mapping: rows.filter((row) => !row.account_mapping_key).length,
		mixedAllocation: rows.filter(
			(row) => row.book === "mixed" && row.business_use_percent === null,
		).length,
		nonCountableDirection: rows.filter(
			(row) => !isCountableDirection(row.direction),
		).length,
	};
	const statusCounts = {
		ready: rows.filter((row) => row.status === "ready").length,
		review: rows.filter((row) => row.status === "review").length,
		blocked: rows.filter((row) => row.status === "blocked").length,
		duplicate: input.periodRows.filter((row) => row.status === "duplicate")
			.length,
	};
	const openJobsThatMayChangeTotals = openJobSummary(input.openJobs);
	const blockers = [
		...(missing.mapping > 0
			? [`${missing.mapping} rows missing mappings`]
			: []),
		...(missing.amount > 0 ? [`${missing.amount} rows missing amount`] : []),
		...(missing.date > 0 ? [`${missing.date} rows missing date`] : []),
		...(missing.counterparty > 0
			? [`${missing.counterparty} rows missing counterparty`]
			: []),
		...(missing.mixedAllocation > 0
			? [`${missing.mixedAllocation} mixed rows missing allocation`]
			: []),
		...(missing.nonCountableDirection > 0
			? [`${missing.nonCountableDirection} rows have non-countable direction`]
			: []),
		...(openJobsThatMayChangeTotals.length > 0
			? ["open jobs may change finance results"]
			: []),
	];
	return {
		status: blockers.length > 0 ? "audit_only" : "ready",
		statusCounts,
		accountMappingCount: input.accountMappingCount,
		missing,
		openJobsThatMayChangeTotals,
		blockers,
	};
}

function isCountableDirection(direction: string) {
	return direction === "income" || direction === "expense";
}

function buildScheduleC(rows: LedgerRow[]) {
	const businessRows = rows.filter(
		(row) => row.book === "business" || row.book === "mixed",
	);
	const isTaxesAndLicenses = (row: LedgerRow) =>
		rowCategory(row) === "taxes" && rowSubcategory(row) !== "estimated_tax";
	const expenseLine = (categories: string[], subcategories: string[] = []) =>
		lineValue(
			businessRows,
			(row) =>
				row.direction === "expense" &&
				categories.includes(rowCategory(row)) &&
				(subcategories.length === 0 ||
					subcategories.includes(rowSubcategory(row) ?? "")),
			businessAmountMinor,
		);
	const otherCategories = [
		"software_services",
		"subscriptions",
		"banking_fees",
		"education",
	];
	return {
		lines: {
			grossReceipts: lineValue(
				businessRows,
				(row) => row.direction === "income",
				businessAmountMinor,
			),
			contractLabor: expenseLine(["payroll_contractors"], ["contractor"]),
			wages: expenseLine(["payroll_contractors"], ["payroll"]),
			insurance: expenseLine(["insurance"]),
			taxesAndLicenses: lineValue(
				businessRows,
				(row) => row.direction === "expense" && isTaxesAndLicenses(row),
				businessAmountMinor,
			),
			travel: expenseLine(["travel"]),
			meals: expenseLine(["meals"]),
			utilities: expenseLine(["utilities"]),
			officeSupplies: lineValue(
				businessRows,
				(row) =>
					row.direction === "expense" &&
					(rowCategory(row) === "office_business" ||
						(rowCategory(row) === "shopping" &&
							rowSubcategory(row) === "supplies")),
				businessAmountMinor,
			),
			otherExpenses: lineValue(
				businessRows,
				(row) =>
					row.direction === "expense" &&
					otherCategories.includes(rowCategory(row)),
				businessAmountMinor,
			),
		},
		otherExpenseDetails: otherCategories.map((category) => ({
			category,
			...lineValue(
				businessRows,
				(row) => row.direction === "expense" && rowCategory(row) === category,
				businessAmountMinor,
			),
		})),
	};
}

function buildScheduleA(rows: LedgerRow[]) {
	const personalRows = rows.filter(
		(row) => row.book === "personal" || row.book === "mixed",
	);
	return {
		candidates: {
			taxes: lineValue(
				personalRows,
				(row) => row.direction === "expense" && rowCategory(row) === "taxes",
				personalAmountMinor,
			),
			donations: lineValue(
				personalRows,
				(row) =>
					row.direction === "expense" && rowCategory(row) === "donations",
				personalAmountMinor,
			),
			healthcare: lineValue(
				personalRows,
				(row) =>
					row.direction === "expense" && rowCategory(row) === "healthcare",
				personalAmountMinor,
			),
		},
	};
}

function investmentDispositionRows(rows: LedgerRow[]) {
	return rows.filter((row) => rowCategory(row) === "investments");
}

function buildFormValues(input: {
	taxYear: number;
	generatedAt: string;
	readiness: ReturnType<typeof readinessForPackage>;
	acceptedRows: LedgerRow[];
	periodRows: LedgerRow[];
}) {
	const scheduleC = buildScheduleC(input.acceptedRows);
	const scheduleCIncome = scheduleC.lines.grossReceipts.amountMinor;
	const scheduleCExpenses = [
		scheduleC.lines.contractLabor,
		scheduleC.lines.wages,
		scheduleC.lines.insurance,
		scheduleC.lines.taxesAndLicenses,
		scheduleC.lines.travel,
		scheduleC.lines.meals,
		scheduleC.lines.utilities,
		scheduleC.lines.officeSupplies,
		scheduleC.lines.otherExpenses,
	].reduce((sum, line) => sum + line.amountMinor, 0);
	const form8949Rows = investmentDispositionRows(input.periodRows);
	return {
		schemaVersion: "tax-form-values.v1",
		taxYear: input.taxYear,
		generatedAt: input.generatedAt,
		readiness: input.readiness,
		forms: {
			scheduleC: {
				lines: scheduleC.lines,
				otherExpenseDetails: scheduleC.otherExpenseDetails,
				netProfitMinor: scheduleCIncome - scheduleCExpenses,
			},
			scheduleSE: {
				handoff: {
					scheduleCNetProfitMinor: scheduleCIncome - scheduleCExpenses,
					requiresOperatorReview: true,
				},
			},
			scheduleA: buildScheduleA(input.acceptedRows),
			form8949: {
				candidates: form8949Rows.map((row) => ({
					ledgerEntryId: row.id,
					date: ledgerDate(row),
					counterparty: row.counterparty,
					amountMinor: amountMinor(row),
					status: row.status,
				})),
			},
		},
		sourceLedgerEntryIds: input.acceptedRows.map((row) => row.id),
		manualInputsRequired: [
			"Confirm filing posture, entity treatment, accounting method, business code, and EIN needs.",
			"Provide W-2, 1099, brokerage, payroll, and source statement coverage not already imported.",
			"Review pending and blocked ledger rows before using accepted totals.",
			"Provide home office, mileage, depreciation, inventory, and asset purchase inputs when applicable.",
			...(form8949Rows.length > 0
				? [
						"Provide cost basis and holding periods for investment dispositions.",
					]
				: []),
		],
	};
}

function renderWorkpaper(input: {
	title: string;
	reportKind: TaxReportKind;
	year: number;
	quarter?: number | null;
	acceptedSummary: ReturnType<typeof summarizeRows>;
	reviewRows: LedgerRow[];
	readiness?: ReturnType<typeof readinessForPackage>;
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
		...(input.readiness
			? [
					"## Readiness Gates",
					"",
					`- account mappings: ${input.readiness.accountMappingCount}`,
					`- ready/review/blocked: ${input.readiness.statusCounts.ready}/${input.readiness.statusCounts.review}/${input.readiness.statusCounts.blocked}`,
					`- missing mappings: ${input.readiness.missing.mapping}`,
					`- missing amount/date/counterparty: ${input.readiness.missing.amount}/${input.readiness.missing.date}/${input.readiness.missing.counterparty}`,
					`- non-countable directions: ${input.readiness.missing.nonCountableDirection}`,
					"",
					"## Manual Inputs",
					"",
					"- Confirm final filing posture and entity treatment.",
					"- Reconcile source statements, 1099s, W-2s, brokerage forms, payroll, and payment processor records.",
					"- Review pending mappings and blocked rows before relying on accepted totals.",
					"",
				]
			: []),
	].join("\n");
}

function renderLine(
	label: string,
	line: { amountMinor: number; ledgerEntryIds: string[] },
) {
	return `| ${label} | ${money(line.amountMinor)} | ${line.ledgerEntryIds.length} |`;
}

function renderScheduleCWorkpaper(
	formValues: ReturnType<typeof buildFormValues>,
) {
	const lines = formValues.forms.scheduleC.lines;
	return [
		"# Schedule C Workpaper",
		"",
		"Candidate values use only `ready` business or mixed ledger rows.",
		"",
		"| Candidate line | Amount | Rows |",
		"| --- | ---: | ---: |",
		renderLine("Gross receipts", lines.grossReceipts),
		renderLine("Contract labor", lines.contractLabor),
		renderLine("Wages", lines.wages),
		renderLine("Insurance", lines.insurance),
		renderLine("Taxes and licenses", lines.taxesAndLicenses),
		renderLine("Travel", lines.travel),
		renderLine("Meals", lines.meals),
		renderLine("Utilities", lines.utilities),
		renderLine("Office and supplies", lines.officeSupplies),
		renderLine("Other expenses", lines.otherExpenses),
		"",
		`Net candidate profit: ${money(formValues.forms.scheduleC.netProfitMinor)}`,
		"",
		"## Other Expense Detail",
		"",
		"| Category | Amount | Rows |",
		"| --- | ---: | ---: |",
		...formValues.forms.scheduleC.otherExpenseDetails.map((detail) =>
			renderLine(detail.category, detail),
		),
		"",
	].join("\n");
}

function renderScheduleSEWorkpaper(
	formValues: ReturnType<typeof buildFormValues>,
) {
	return [
		"# Schedule SE Workpaper",
		"",
		"Schedule SE values are handoff candidates from Schedule C workpaper output.",
		"",
		`Schedule C net profit candidate: ${money(
			formValues.forms.scheduleSE.handoff.scheduleCNetProfitMinor,
		)}`,
		"",
		"Manual review is required before filing use.",
		"",
	].join("\n");
}

function renderScheduleAWorkpaper(
	formValues: ReturnType<typeof buildFormValues>,
) {
	const candidates = formValues.forms.scheduleA.candidates;
	return [
		"# Schedule A Workpaper",
		"",
		"Candidate values use only `ready` personal or mixed ledger rows.",
		"",
		"| Candidate bucket | Amount | Rows |",
		"| --- | ---: | ---: |",
		renderLine("Taxes", candidates.taxes),
		renderLine("Donations", candidates.donations),
		renderLine("Healthcare", candidates.healthcare),
		"",
	].join("\n");
}

function renderForm8949Workpaper(
	formValues: ReturnType<typeof buildFormValues>,
) {
	return [
		"# Form 8949 Workpaper",
		"",
		"Investment disposition candidates require cost basis and holding period review.",
		"",
		"| Ledger entry | Date | Counterparty | Amount | Status |",
		"| --- | --- | --- | ---: | --- |",
		...formValues.forms.form8949.candidates.map(
			(row) =>
				`| ${row.ledgerEntryId} | ${row.date ?? ""} | ${row.counterparty ?? ""} | ${money(
					row.amountMinor ?? 0,
				)} | ${row.status} |`,
		),
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
	const allLedgerRows = await db
		.selectFrom("finance_ledger_entries")
		.selectAll()
		.orderBy("occurred_at", "asc")
		.orderBy("posted_at", "asc")
		.execute();
	const periodRows = allLedgerRows.filter((row) =>
		inSelectedPeriod(row, input),
	);
	const ledgerRows = periodRows.filter((row) => belongsToReport(row, input));
	const acceptedRows = ledgerRows.filter(isAcceptedReportRow);
	const reviewRows = ledgerRows.filter((row) => !isAcceptedReportRow(row));
	const acceptedFormRows = periodRows.filter(isAcceptedReportRow);
	const [accountMappingCount, openJobs] = await Promise.all([
		db
			.selectFrom("finance_account_mappings")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("jobs")
			.select(["kind", "status"])
			.where("status", "in", ["queued", "running"])
			.where("kind", "in", [
				"classify_account_backlog",
				"classify_root_messages",
				"classify_finance_backlog",
				"classify_finance_messages",
				"classify_review_backlog",
				"generate_finance_mapping_candidates",
				"reconcile_registry_suggestions",
				"import_operator_registry",
				"rebuild_finance_knowledge",
				"rebuild_finance_rollups",
			])
			.execute(),
	]);
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
	const readiness = readinessForPackage({
		periodRows,
		accountMappingCount: Number(accountMappingCount.count),
		openJobs,
	});
	const status =
		readiness.blockers.length > 0 || acceptedRows.length === 0
			? "audit_only"
			: "complete";
	const formValues = buildFormValues({
		taxYear: input.year,
		generatedAt,
		readiness,
		acceptedRows: acceptedFormRows,
		periodRows,
	});
	const hasForm8949 = formValues.forms.form8949.candidates.length > 0;
	const validation = {
		acceptedTotalsUseReadyOnly: true,
		noReadyRows: acceptedRows.length === 0,
		reviewRowsExcludedFromAcceptedTotals: true,
		rawRfc822Included: false,
		fullAccountNumbersIncluded: false,
	};
	const snapshot = {
		ledgerRowCount: allLedgerRows.length,
		periodLedgerRowCount: periodRows.length,
		acceptedLedgerRowCount: acceptedRows.length,
		reviewLedgerRowCount: reviewRows.length,
		ledgerUpdatedAtMax: maxIsoValue(
			allLedgerRows.map((row) => row.updated_at ?? null),
		),
		openJobsAtGeneration: readiness.openJobsThatMayChangeTotals,
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
			formValues: "forms/form-values.json",
			scheduleCWorkpaper: "forms/schedule-c-workpaper.md",
			scheduleSEWorkpaper: "forms/schedule-se-workpaper.md",
			scheduleAWorkpaper: "forms/schedule-a-workpaper.md",
			form8949Workpaper: hasForm8949 ? "forms/form-8949-workpaper.md" : null,
		},
		acceptedSummary,
		reviewSummary,
		readiness,
		snapshot,
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
			readiness,
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
	writeFileSync(
		resolve(outDir, "forms", "form-values.json"),
		`${JSON.stringify(formValues, null, 2)}\n`,
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "forms", "schedule-c-workpaper.md"),
		renderScheduleCWorkpaper(formValues),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "forms", "schedule-se-workpaper.md"),
		renderScheduleSEWorkpaper(formValues),
		"utf8",
	);
	writeFileSync(
		resolve(outDir, "forms", "schedule-a-workpaper.md"),
		renderScheduleAWorkpaper(formValues),
		"utf8",
	);
	if (hasForm8949) {
		writeFileSync(
			resolve(outDir, "forms", "form-8949-workpaper.md"),
			renderForm8949Workpaper(formValues),
			"utf8",
		);
	}

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
