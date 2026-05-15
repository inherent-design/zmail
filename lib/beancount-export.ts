import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { nowIso } from "#/lib/config";
import { getDb, jsonText } from "#/lib/db";
import { resolveBeancountDate } from "#/lib/finance-ledger-dates";
import { financeLedgerExportV2Schema } from "#/lib/schemas";

const EXPORT_CONFIDENCE_THRESHOLD = 0.8;
const VALID_BOOKS = new Set(["personal", "business", "mixed"]);
const BAD_DIRECTIONS = new Set(["both", "neither", "unknown"]);
const DOCUMENT_SOURCE_KINDS = new Set([
	"pdf",
	"csv",
	"ofx",
	"text",
	"statement",
]);

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
	occurred_at_precision: string;
	posted_at: string | null;
	posted_at_precision: string;
	cleared_at: string | null;
	cleared_at_precision: string;
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
	created_at: string;
	updated_at: string;
}

interface SourceRow {
	id: string;
	ledger_entry_id: string | null;
	source_kind: string;
	message_id: string | null;
	secondary_result_id: string | null;
	import_run_id: string | null;
	import_transaction_id: string | null;
	import_document_id: string | null;
	evidence_json: string;
	created_at: string;
}

interface ImportRunRow {
	id: string;
	source_kind: string;
	source_file_path: string;
	source_file_sha256: string;
	filename: string;
	artifact_sha256: string;
	raw_artifact_json: string;
	imported_at: string;
}

interface ImportDocumentRow {
	id: string;
	import_run_id: string;
	source_document_ref: string | null;
	document_type: string;
	payload_json: string;
}

type ExportReason =
	| `status=${string}`
	| `direction=${string}`
	| "missing_exact_beancount_date"
	| "missing_amount"
	| "missing_currency"
	| "missing_counterparty"
	| "invalid_book_scope"
	| "missing_business_use_percent"
	| "missing_debit_account"
	| "missing_credit_account"
	| "missing_account_mapping_key"
	| "missing_dedupe_key"
	| "missing_confidence"
	| "confidence_below_threshold";

type EligibilityResult = {
	exportable: boolean;
	reasons: ExportReason[];
	beancountDate: string | null;
	beancountDateSource: "occurred_at" | "posted_at" | "cleared_at" | null;
	dateRecovery: Record<string, unknown> | null;
	amountMinor: number | null;
	currency: string | null;
	confidenceUsed: number | null;
	threshold: number;
	counterparty: string | null;
};

type ReadinessSummary = {
	readyCount: number;
	reviewCount: number;
	blockedCount: number;
	duplicateCount: number;
	mappingCoverage: {
		mappedRows: number;
		totalRows: number;
		ratio: number;
	};
	missingAmountCount: number;
	missingCurrencyCount: number;
	missingDateCount: number;
	missingCounterpartyCount: number;
	missingDedupeCount: number;
	invalidBookCount: number;
	mixedMissingBusinessUsePercentCount: number;
	badDirectionCount: number;
};

type ExportRowContext = {
	row: LedgerRow;
	source: SourceRow | null;
	importRun: ImportRunRow | null;
	importDocument: ImportDocumentRow | null;
	eligibility: EligibilityResult;
};

type DocumentEmission = {
	relativePaths: string[];
	lines: string[];
	missing: DocumentMissingMeta[];
};

type DocumentCopiedMeta = {
	relativePath: string;
	importRunId: string;
	importDocumentId: string | null;
	sourceDocumentRef: string | null;
	sourcePath: string;
};

type DocumentMissingMeta = {
	importRunId: string;
	importDocumentId: string | null;
	sourceDocumentRef: string | null;
	sourcePath: string;
	reason: string;
};

type InternalExportValidationCheck = {
	name: string;
	status: "passed" | "failed";
	detail: string;
};

export type InternalExportValidationResult = {
	status: "passed" | "failed";
	checks: InternalExportValidationCheck[];
	summary: {
		total: number;
		passed: number;
		failed: number;
	};
};

type RenderedExportTransaction = {
	canonicalKey: string;
	beancountDate: string;
	generatedFile: string;
	beancountLink: string;
	body: string;
};

function quote(value: string) {
	return JSON.stringify(value);
}

function safeJsonParse<T>(input: string | null, fallback: T) {
	if (!input) {
		return fallback;
	}
	try {
		return JSON.parse(input) as T;
	} catch {
		return fallback;
	}
}

function rawLedgerDate(
	row: Pick<LedgerRow, "occurred_at" | "posted_at" | "cleared_at">,
) {
	return row.occurred_at ?? row.posted_at ?? row.cleared_at ?? "";
}

function parseMinorAmount(
	row: Pick<LedgerRow, "amount_minor" | "amount_value">,
) {
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

function sanitizeDocumentName(value: string) {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function validAccountName(value: string | null) {
	if (!value) {
		return false;
	}
	return /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z][A-Za-z0-9_-]*)+$/.test(
		value,
	);
}

function chooseConfidence(row: LedgerRow) {
	const parsed = safeJsonParse<Record<string, unknown>>(
		row.field_confidence_json,
		{},
	);
	const accountMapping = parsed.accountMapping;
	if (
		typeof accountMapping === "number" &&
		accountMapping >= 0 &&
		accountMapping <= 1
	) {
		return accountMapping;
	}
	const overall = parsed.overall;
	if (typeof overall === "number" && overall >= 0 && overall <= 1) {
		return overall;
	}
	return null;
}

function csvCell(value: unknown) {
	const text = value === null || value === undefined ? "" : String(value);
	if (/[",\n\r]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

function deriveLedgerYear(row: LedgerRow, eligibility?: EligibilityResult) {
	const exactDate =
		eligibility?.beancountDate ?? resolveBeancountDate(row).beancountDate;
	if (exactDate) {
		return Number.parseInt(exactDate.slice(0, 4), 10);
	}
	const rawDate = rawLedgerDate(row);
	const match = rawDate.match(/^(\d{4})/);
	if (!match) {
		return null;
	}
	const year = Number.parseInt(match[1], 10);
	return Number.isInteger(year) ? year : null;
}

function chooseDocumentAccount(row: LedgerRow) {
	if (
		row.debit_account?.startsWith("Assets:") ||
		row.debit_account?.startsWith("Liabilities:")
	) {
		return row.debit_account;
	}
	if (
		row.credit_account?.startsWith("Assets:") ||
		row.credit_account?.startsWith("Liabilities:")
	) {
		return row.credit_account;
	}
	if (validAccountName(row.debit_account)) {
		return row.debit_account;
	}
	if (validAccountName(row.credit_account)) {
		return row.credit_account;
	}
	return null;
}

export function evaluateExportEligibility(row: LedgerRow) {
	const resolution = resolveBeancountDate(row);
	const amountMinor = parseMinorAmount(row);
	const currency = row.currency?.trim() || null;
	const counterparty = row.counterparty?.trim() || null;
	const confidenceUsed = chooseConfidence(row);
	const reasons: ExportReason[] = [];

	if (row.status !== "ready") {
		reasons.push(`status=${row.status}`);
	}
	if (!resolution.beancountDate) {
		reasons.push("missing_exact_beancount_date");
	}
	if (amountMinor === null || amountMinor === 0) {
		reasons.push("missing_amount");
	}
	if (!currency) {
		reasons.push("missing_currency");
	}
	if (row.direction !== "income" && row.direction !== "expense") {
		reasons.push(`direction=${row.direction}`);
	}
	if (!counterparty) {
		reasons.push("missing_counterparty");
	}
	if (!VALID_BOOKS.has(row.book)) {
		reasons.push("invalid_book_scope");
	}
	if (row.book === "mixed" && row.business_use_percent === null) {
		reasons.push("missing_business_use_percent");
	}
	if (!validAccountName(row.debit_account)) {
		reasons.push("missing_debit_account");
	}
	if (!validAccountName(row.credit_account)) {
		reasons.push("missing_credit_account");
	}
	if (!row.account_mapping_key?.trim()) {
		reasons.push("missing_account_mapping_key");
	}
	if (!row.canonical_key.trim()) {
		reasons.push("missing_dedupe_key");
	}
	if (confidenceUsed === null) {
		reasons.push("missing_confidence");
	} else if (confidenceUsed < EXPORT_CONFIDENCE_THRESHOLD) {
		reasons.push("confidence_below_threshold");
	}

	return {
		exportable: reasons.length === 0,
		reasons,
		beancountDate: resolution.beancountDate,
		beancountDateSource: resolution.beancountDateSource,
		dateRecovery: resolution.dateRecovery,
		amountMinor,
		currency,
		confidenceUsed,
		threshold: EXPORT_CONFIDENCE_THRESHOLD,
		counterparty,
	} satisfies EligibilityResult;
}

export function summarizeExportReadiness(
	rows: Array<{ row: LedgerRow; eligibility?: EligibilityResult }>,
) {
	const readiness: ReadinessSummary = {
		readyCount: 0,
		reviewCount: 0,
		blockedCount: 0,
		duplicateCount: 0,
		mappingCoverage: {
			mappedRows: 0,
			totalRows: 0,
			ratio: 0,
		},
		missingAmountCount: 0,
		missingCurrencyCount: 0,
		missingDateCount: 0,
		missingCounterpartyCount: 0,
		missingDedupeCount: 0,
		invalidBookCount: 0,
		mixedMissingBusinessUsePercentCount: 0,
		badDirectionCount: 0,
	};

	for (const entry of rows) {
		const eligibility =
			entry.eligibility ?? evaluateExportEligibility(entry.row);
		if (entry.row.status === "ready") {
			readiness.readyCount += 1;
		} else if (entry.row.status === "review") {
			readiness.reviewCount += 1;
		} else if (entry.row.status === "blocked") {
			readiness.blockedCount += 1;
		} else if (entry.row.status === "duplicate") {
			readiness.duplicateCount += 1;
		}
		if (entry.row.status !== "duplicate") {
			readiness.mappingCoverage.totalRows += 1;
			if (entry.row.account_mapping_key?.trim()) {
				readiness.mappingCoverage.mappedRows += 1;
			}
		}
		if (eligibility.reasons.includes("missing_amount")) {
			readiness.missingAmountCount += 1;
		}
		if (eligibility.reasons.includes("missing_currency")) {
			readiness.missingCurrencyCount += 1;
		}
		if (eligibility.reasons.includes("missing_exact_beancount_date")) {
			readiness.missingDateCount += 1;
		}
		if (eligibility.reasons.includes("missing_counterparty")) {
			readiness.missingCounterpartyCount += 1;
		}
		if (eligibility.reasons.includes("missing_dedupe_key")) {
			readiness.missingDedupeCount += 1;
		}
		if (eligibility.reasons.includes("invalid_book_scope")) {
			readiness.invalidBookCount += 1;
		}
		if (eligibility.reasons.includes("missing_business_use_percent")) {
			readiness.mixedMissingBusinessUsePercentCount += 1;
		}
		if (
			eligibility.reasons.some((reason) =>
				BAD_DIRECTIONS.has(reason.replace("direction=", "")),
			)
		) {
			readiness.badDirectionCount += 1;
		}
	}

	readiness.mappingCoverage.ratio =
		readiness.mappingCoverage.totalRows === 0
			? 1
			: readiness.mappingCoverage.mappedRows /
				readiness.mappingCoverage.totalRows;

	return readiness;
}

function renderTransaction(input: {
	context: ExportRowContext;
	exportRunId: string;
}) {
	const { context } = input;
	if (!context.eligibility.exportable || !context.eligibility.beancountDate) {
		throw new Error(`Ledger row is not exportable: ${context.row.id}`);
	}

	const payee =
		context.eligibility.counterparty ?? context.row.counterparty ?? "";
	const narration = context.row.description ?? context.row.direction;
	const link = `^zmail-${sanitizeBeancountLinkPart(context.row.canonical_key)}`;
	const amount = formatMinorAmount(
		Math.abs(context.eligibility.amountMinor ?? 0),
	);
	const oppositeAmount = formatMinorAmount(
		-Math.abs(context.eligibility.amountMinor ?? 0),
	);
	const source = context.source?.source_kind ?? context.row.source_authority;
	const metadata = [
		`  zmail_book: ${quote(context.row.book)}`,
		`  zmail_beancount_date_source: ${quote(
			context.eligibility.beancountDateSource ?? "unknown",
		)}`,
		`  zmail_confidence: ${quote(context.row.field_confidence_json)}`,
		`  zmail_source: ${quote(source)}`,
		`  zmail_canonical_key: ${quote(context.row.canonical_key)}`,
		...(context.row.occurred_at
			? [`  zmail_occurred_at: ${quote(context.row.occurred_at)}`]
			: []),
		...(context.row.posted_at
			? [`  zmail_posted_at: ${quote(context.row.posted_at)}`]
			: []),
		...(context.eligibility.dateRecovery
			? [
					`  zmail_date_recovery: ${quote(
						JSON.stringify(context.eligibility.dateRecovery),
					)}`,
				]
			: []),
		...(context.source?.message_id
			? [`  zmail_message_id: ${quote(context.source.message_id)}`]
			: []),
		`  zmail_export_run_id: ${quote(input.exportRunId)}`,
	];

	return {
		beancountLink: `zmail-${sanitizeBeancountLinkPart(context.row.canonical_key)}`,
		body: [
			`${context.eligibility.beancountDate} * ${quote(payee)} ${quote(
				narration,
			)} ${link}`,
			...metadata,
			`  ${context.row.debit_account}  ${amount} ${context.eligibility.currency}`,
			`  ${context.row.credit_account}  ${oppositeAmount} ${context.eligibility.currency}`,
			"",
		].join("\n"),
	};
}

function renderAccounts(entries: ExportRowContext[], defaultYear: number) {
	const accounts = Array.from(
		new Set(
			entries.flatMap((entry) => [
				entry.row.debit_account ?? "",
				entry.row.credit_account ?? "",
			]),
		),
	)
		.filter((account) => validAccountName(account))
		.sort();

	const openDate = `${defaultYear}-01-01`;
	if (accounts.length === 0) {
		return [
			"; zmail generated accounts",
			`${openDate} open Assets:Personal:Opening-Balances`,
			`${openDate} open Equity:Opening-Balances`,
			"",
		].join("\n");
	}

	return [
		"; zmail generated accounts",
		...accounts.map((account) => `${openDate} open ${account}`),
		"",
	].join("\n");
}

function exportableCurrencies(entries: ExportRowContext[]) {
	const currencies = entries
		.map((entry) => entry.eligibility.currency?.trim())
		.filter((currency): currency is string => Boolean(currency));
	return Array.from(new Set(currencies)).sort();
}

function renderMain(generatedFiles: string[], currencies: string[]) {
	const operatingCurrencies = currencies.length > 0 ? currencies : ["USD"];
	return [
		'option "title" "zmail Finance Export"',
		...operatingCurrencies.map(
			(currency) => `option "operating_currency" ${quote(currency)}`,
		),
		'include "accounts.beancount"',
		...generatedFiles.map((generatedFile) => `include "${generatedFile}"`),
		"",
	].join("\n");
}

function unresolvedCsv(rows: ExportRowContext[]) {
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
	const body = rows.map((entry) =>
		[
			entry.row.canonical_key,
			entry.row.status,
			entry.eligibility.reasons.join(";"),
			rawLedgerDate(entry.row),
			entry.row.amount_value,
			entry.row.currency,
			entry.row.counterparty,
			entry.row.book,
		]
			.map(csvCell)
			.join(","),
	);
	return [header, ...body, ""].join("\n");
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

function validationResult(checks: InternalExportValidationCheck[]) {
	const failed = checks.filter((check) => check.status === "failed").length;
	return {
		status: failed === 0 ? ("passed" as const) : ("failed" as const),
		checks,
		summary: {
			total: checks.length,
			passed: checks.length - failed,
			failed,
		},
	} satisfies InternalExportValidationResult;
}

function generatedYear(relativePath: string) {
	const match = /^generated\/(\d{4})\.beancount$/.exec(relativePath);
	return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function checkStatus(
	name: string,
	passed: boolean,
	passedDetail: string,
	failedDetail: string,
) {
	return {
		name,
		status: passed ? ("passed" as const) : ("failed" as const),
		detail: passed ? passedDetail : failedDetail,
	};
}

function parsePostingLines(body: string) {
	return body
		.split("\n")
		.map((line) => line.trim())
		.flatMap((line) => {
			const match =
				/^(Assets|Liabilities|Equity|Income|Expenses)(?::[A-Za-z0-9_-]+)+\s+(-?\d+(?:\.\d+)?)\s+([A-Z][A-Z0-9._-]*)$/.exec(
					line,
				);
			if (!match) {
				return [];
			}
			return [
				{
					amountMinor: Math.round(Number.parseFloat(match[2] ?? "0") * 100),
					currency: match[3] ?? "",
				},
			];
		});
}

export function runInternalExportValidation(input: {
	packageDir: string;
	manifest: ReturnType<typeof financeLedgerExportV2Schema.parse>;
	generatedFiles: Array<{ relativePath: string; body: string }>;
	exportedTransactions: RenderedExportTransaction[];
	exportedRowCount: number;
	unresolvedRowCount: number;
}) {
	const checks: InternalExportValidationCheck[] = [];
	const generatedYears = input.manifest.files.generated.map(generatedYear);
	const generatedFilesSorted =
		generatedYears.every((year) => year !== null) &&
		input.manifest.files.generated.every((file, index, files) => {
			if (index === 0) {
				return true;
			}
			return file.localeCompare(files[index - 1] ?? "") >= 0;
		}) &&
		generatedYears.every((year, index, years) => {
			if (index === 0 || year === null) {
				return year !== null;
			}
			const previous = years[index - 1];
			return previous !== null && year >= previous;
		});
	checks.push(
		checkStatus(
			"generated-files-sorted",
			generatedFilesSorted,
			"Generated files are sorted by year ascending.",
			`Generated files are not sorted year paths: ${input.manifest.files.generated.join(", ")}`,
		),
	);
	const generatedBodyFiles = input.generatedFiles
		.map((file) => file.relativePath)
		.sort();
	const manifestGeneratedFiles = [...input.manifest.files.generated].sort();
	const generatedFilesMatchManifest =
		generatedBodyFiles.length === manifestGeneratedFiles.length &&
		generatedBodyFiles.every(
			(file, index) => file === manifestGeneratedFiles[index],
		);
	checks.push(
		checkStatus(
			"generated-files-match-manifest",
			generatedFilesMatchManifest,
			"Generated file bodies match manifest generated file list.",
			`Generated bodies ${generatedBodyFiles.join(", ")} differ from manifest ${manifestGeneratedFiles.join(", ")}`,
		),
	);

	const exportedRowsSorted = input.exportedTransactions.every(
		(transaction, index, transactions) => {
			if (index === 0) {
				return true;
			}
			const previous = transactions[index - 1];
			if (!previous) {
				return true;
			}
			return (
				previous.beancountDate.localeCompare(transaction.beancountDate) < 0 ||
				(previous.beancountDate === transaction.beancountDate &&
					previous.canonicalKey.localeCompare(transaction.canonicalKey) <= 0)
			);
		},
	);
	checks.push(
		checkStatus(
			"export-rows-sorted",
			exportedRowsSorted,
			"Exported rows are sorted by Beancount date and canonical key.",
			"Exported rows are not sorted by Beancount date and canonical key.",
		),
	);

	const invalidPostingCounts = input.exportedTransactions
		.filter((transaction) => parsePostingLines(transaction.body).length !== 2)
		.map((transaction) => transaction.canonicalKey);
	checks.push(
		checkStatus(
			"transaction-posting-count",
			invalidPostingCounts.length === 0,
			"Every exported transaction has exactly two postings.",
			`Transactions with invalid posting counts: ${invalidPostingCounts.join(", ")}`,
		),
	);

	const unbalanced = input.exportedTransactions
		.filter((transaction) => {
			const postings = parsePostingLines(transaction.body);
			if (postings.length !== 2) {
				return true;
			}
			const currency = postings[0]?.currency;
			return (
				!currency ||
				postings.some((posting) => posting.currency !== currency) ||
				postings.reduce((sum, posting) => sum + posting.amountMinor, 0) !== 0
			);
		})
		.map((transaction) => transaction.canonicalKey);
	checks.push(
		checkStatus(
			"transaction-postings-balance",
			unbalanced.length === 0,
			"Every exported transaction nets to zero by currency.",
			`Unbalanced exported transactions: ${unbalanced.join(", ")}`,
		),
	);

	const existingGenerated = new Set(
		input.generatedFiles.map((file) => file.relativePath),
	);
	const referencedGenerated = new Set([
		...input.manifest.files.generated,
		...input.exportedTransactions.map(
			(transaction) => transaction.generatedFile,
		),
		...input.manifest.rows.flatMap((row) =>
			row.export.status === "exported" && row.export.generatedFile
				? [row.export.generatedFile]
				: [],
		),
	]);
	const missingGenerated = [...referencedGenerated].filter(
		(file) =>
			!existsSync(resolve(input.packageDir, file)) ||
			!existingGenerated.has(file),
	);
	checks.push(
		checkStatus(
			"referenced-generated-files-exist",
			missingGenerated.length === 0,
			"All referenced generated files exist in the package.",
			`Missing referenced generated files: ${missingGenerated.join(", ")}`,
		),
	);

	const missingDocuments = input.manifest.files.documents.filter(
		(file) => !existsSync(resolve(input.packageDir, file)),
	);
	checks.push(
		checkStatus(
			"document-files-exist",
			missingDocuments.length === 0,
			"All manifest document files exist in the package.",
			`Missing document files: ${missingDocuments.join(", ")}`,
		),
	);

	const exportedItemCount = input.manifest.items.filter(
		(item) => item.status === "exported",
	).length;
	const unresolvedItemCount = input.manifest.items.filter(
		(item) => item.status === "unresolved",
	).length;
	const exportedRowCount = input.manifest.rows.filter(
		(row) => row.export.status === "exported",
	).length;
	const unresolvedRowCount = input.manifest.rows.filter(
		(row) => row.export.status === "unresolved",
	).length;
	const itemCountsMatch =
		exportedItemCount === input.exportedRowCount &&
		exportedRowCount === input.exportedRowCount &&
		unresolvedItemCount === input.unresolvedRowCount &&
		unresolvedRowCount === input.unresolvedRowCount;
	checks.push(
		checkStatus(
			"manifest-item-counts-match",
			itemCountsMatch,
			"Manifest item and row counts match export scope counts.",
			`Manifest counts exported=${String(exportedItemCount)}/${String(
				exportedRowCount,
			)} unresolved=${String(unresolvedItemCount)}/${String(
				unresolvedRowCount,
			)} expected exported=${String(input.exportedRowCount)} unresolved=${String(
				input.unresolvedRowCount,
			)}`,
		),
	);

	const exportedRowsMissingLinks = input.manifest.rows
		.filter(
			(row) =>
				row.export.status === "exported" &&
				(!row.export.generatedFile || !row.export.beancountLink),
		)
		.map((row) =>
			String(row.ledgerEntry.canonical_key ?? row.ledgerEntry.id ?? "unknown"),
		);
	const exportedItemsMissingLinks = input.manifest.items
		.filter((item) => item.status === "exported" && !item.beancountLink)
		.map((item) => item.canonicalKey);
	const rowsHaveFilesAndLinks =
		exportedRowsMissingLinks.length === 0 &&
		exportedItemsMissingLinks.length === 0;
	checks.push(
		checkStatus(
			"exported-rows-have-files-and-links",
			rowsHaveFilesAndLinks,
			"Every exported row has one generated file and one Beancount link.",
			`Exported rows/items missing files or links: ${[
				...exportedRowsMissingLinks,
				...exportedItemsMissingLinks,
			].join(", ")}`,
		),
	);

	return validationResult(checks);
}

function loadFileText(path: string) {
	return readFileSync(path, "utf8");
}

function prepareDocumentEmission(
	context: ExportRowContext,
	packageDir: string,
	copiedDocuments: Map<string, string>,
	documentsMeta: {
		copied: Map<string, DocumentCopiedMeta>;
		missing: Map<string, DocumentMissingMeta>;
	},
) {
	const result: DocumentEmission = {
		relativePaths: [],
		lines: [],
		missing: [],
	};
	const sourceKind =
		context.importRun?.source_kind ?? context.source?.source_kind;
	if (
		!context.eligibility.exportable ||
		!context.eligibility.beancountDate ||
		!context.source?.import_run_id ||
		!context.importRun ||
		!sourceKind ||
		!DOCUMENT_SOURCE_KINDS.has(sourceKind)
	) {
		return result;
	}

	const sourcePath = context.importRun.source_file_path?.trim();
	if (!sourcePath) {
		return result;
	}
	if (!existsSync(sourcePath)) {
		const missing = {
			importRunId: context.importRun.id,
			importDocumentId:
				context.importDocument?.id ?? context.source.import_document_id ?? null,
			sourceDocumentRef: context.importDocument?.source_document_ref ?? null,
			sourcePath,
			reason: "source_file_missing",
		} satisfies DocumentMissingMeta;
		result.missing.push(missing);
		documentsMeta.missing.set(
			`${missing.importRunId}:${missing.importDocumentId ?? ""}:${sourcePath}`,
			missing,
		);
		return result;
	}

	let relativePath = copiedDocuments.get(sourcePath);
	if (!relativePath) {
		const docBase = sanitizeDocumentName(
			`${context.source.import_document_id ?? context.importRun.id}-${basename(sourcePath)}`,
		);
		relativePath = `documents/${docBase || basename(sourcePath)}`;
		copyFileSync(sourcePath, resolve(packageDir, relativePath));
		copiedDocuments.set(sourcePath, relativePath);
	}
	const copied = {
		relativePath,
		importRunId: context.importRun.id,
		importDocumentId:
			context.importDocument?.id ?? context.source.import_document_id ?? null,
		sourceDocumentRef: context.importDocument?.source_document_ref ?? null,
		sourcePath,
	} satisfies DocumentCopiedMeta;
	documentsMeta.copied.set(
		`${copied.relativePath}:${copied.importRunId}:${copied.importDocumentId ?? ""}`,
		copied,
	);
	result.relativePaths.push(relativePath);

	const documentAccount = chooseDocumentAccount(context.row);
	if (!documentAccount) {
		return result;
	}

	result.lines.push(
		`${context.eligibility.beancountDate} document ${documentAccount} ${quote(
			relativePath,
		)}`,
		"",
	);
	return result;
}

function writePackageFiles(input: {
	packageDir: string;
	accountsBody: string;
	generatedFiles: Array<{ relativePath: string; body: string }>;
	mainBody: string;
	unresolvedBody: string;
	manifestBody: string;
}) {
	mkdirSync(resolve(input.packageDir, "generated"), { recursive: true });
	mkdirSync(resolve(input.packageDir, "raw"), { recursive: true });
	mkdirSync(resolve(input.packageDir, "review"), { recursive: true });
	mkdirSync(resolve(input.packageDir, "documents"), { recursive: true });

	writeFileSync(
		resolve(input.packageDir, "accounts.beancount"),
		input.accountsBody,
		"utf8",
	);
	for (const generatedFile of input.generatedFiles) {
		writeFileSync(
			resolve(input.packageDir, generatedFile.relativePath),
			generatedFile.body,
			"utf8",
		);
	}
	writeFileSync(
		resolve(input.packageDir, "main.beancount"),
		input.mainBody,
		"utf8",
	);
	writeFileSync(
		resolve(input.packageDir, "review", "unresolved.csv"),
		input.unresolvedBody,
		"utf8",
	);
	writeFileSync(
		resolve(input.packageDir, "raw", "zmail-finance-export.json"),
		input.manifestBody,
		"utf8",
	);
}

function commitPackageDirectory(input: {
	tempDir: string;
	outDir: string;
	force?: boolean;
}) {
	if (!existsSync(input.outDir)) {
		renameSync(input.tempDir, input.outDir);
		return;
	}
	if (!input.force) {
		throw new Error(
			`Export target already exists: ${input.outDir}. Pass --force to overwrite it.`,
		);
	}

	const backupDir = `${input.outDir}.backup-${Date.now()}`;
	renameSync(input.outDir, backupDir);
	try {
		renameSync(input.tempDir, input.outDir);
		rmSync(backupDir, { recursive: true, force: true });
	} catch (error) {
		if (!existsSync(input.outDir) && existsSync(backupDir)) {
			renameSync(backupDir, input.outDir);
		}
		throw error;
	}
}

export async function exportFinanceBeancountPackage(input: ExportInput) {
	const db = getDb(input.orgId);
	const exportRunId = input.exportRunId ?? randomUUID();
	const generatedAt = nowIso();
	const outDir = resolve(input.outDir);

	const [ledgerRows, sourceRows, importRuns, importDocuments] =
		await Promise.all([
			db
				.selectFrom("finance_ledger_entries")
				.selectAll()
				.orderBy("occurred_at", "asc")
				.orderBy("posted_at", "asc")
				.orderBy("created_at", "asc")
				.execute(),
			db.selectFrom("finance_ledger_entry_sources").selectAll().execute(),
			db
				.selectFrom("finance_import_runs")
				.select([
					"id",
					"source_kind",
					"source_file_path",
					"source_file_sha256",
					"filename",
					"artifact_sha256",
					"raw_artifact_json",
					"imported_at",
				])
				.execute(),
			db
				.selectFrom("finance_import_documents")
				.select([
					"id",
					"import_run_id",
					"source_document_ref",
					"document_type",
					"payload_json",
				])
				.execute(),
		]);

	const importRunsById = new Map(importRuns.map((row) => [row.id, row]));
	const importDocumentsById = new Map(
		importDocuments.map((row) => [row.id, row]),
	);
	const sourcesByEntry = new Map<string, SourceRow>();
	for (const source of sourceRows) {
		if (source.ledger_entry_id && !sourcesByEntry.has(source.ledger_entry_id)) {
			sourcesByEntry.set(source.ledger_entry_id, source);
		}
	}

	const contexts = ledgerRows
		.map((row) => {
			const source = sourcesByEntry.get(row.id) ?? null;
			const importRun = source?.import_run_id
				? (importRunsById.get(source.import_run_id) ?? null)
				: null;
			const importDocument = source?.import_document_id
				? (importDocumentsById.get(source.import_document_id) ?? null)
				: null;
			const eligibility = evaluateExportEligibility(row);
			return {
				row,
				source,
				importRun,
				importDocument,
				eligibility,
			} satisfies ExportRowContext;
		})
		.filter((context) => {
			if (input.year !== undefined) {
				return (
					deriveLedgerYear(context.row, context.eligibility) === input.year
				);
			}
			return true;
		});

	contexts.sort((left, right) => {
		const leftDate = left.eligibility.beancountDate ?? rawLedgerDate(left.row);
		const rightDate =
			right.eligibility.beancountDate ?? rawLedgerDate(right.row);
		return (
			leftDate.localeCompare(rightDate) ||
			left.row.canonical_key.localeCompare(right.row.canonical_key)
		);
	});

	const exportable = contexts.filter(
		(context) => context.eligibility.exportable,
	);
	const unresolved = contexts.filter(
		(context) => !context.eligibility.exportable,
	);
	const scopeYears = Array.from(
		new Set(
			contexts
				.map((context) => deriveLedgerYear(context.row, context.eligibility))
				.filter((year): year is number => year !== null),
		),
	).sort((left, right) => left - right);
	const defaultYear =
		input.year ?? scopeYears[0] ?? new Date(generatedAt).getUTCFullYear();
	const years =
		scopeYears.length > 0
			? scopeYears
			: input.year !== undefined
				? [input.year]
				: [];

	const packageParent = dirname(outDir);
	mkdirSync(packageParent, { recursive: true });
	const tempDir = mkdtempSync(
		resolve(packageParent, `${basename(outDir)}.tmp-`),
	);

	let validation:
		| {
				status: "passed" | "failed" | "skipped";
				output: string | null;
		  }
		| undefined;
	let internalValidation: InternalExportValidationResult | undefined;
	let packageJson:
		| ReturnType<typeof financeLedgerExportV2Schema.parse>
		| undefined;
	let finalStatus: "complete" | "validation_failed" | undefined;

	const persistExportRun = async (
		status: "complete" | "validation_failed",
		manifest: ReturnType<typeof financeLedgerExportV2Schema.parse>,
	) => {
		await db.transaction().execute(async (trx) => {
			await trx
				.insertInto("finance_export_runs")
				.values({
					id: exportRunId,
					status,
					strict: input.strict ? 1 : 0,
					year: input.year ?? null,
					out_dir: outDir,
					package_json: jsonText(manifest),
					validation_json: jsonText(manifest.validation),
					created_at: generatedAt,
					completed_at: nowIso(),
				})
				.onConflict((oc) =>
					oc.column("id").doUpdateSet({
						status,
						strict: input.strict ? 1 : 0,
						year: input.year ?? null,
						out_dir: outDir,
						package_json: jsonText(manifest),
						validation_json: jsonText(manifest.validation),
						completed_at: nowIso(),
					}),
				)
				.execute();

			await trx
				.deleteFrom("finance_export_items")
				.where("export_run_id", "=", exportRunId)
				.execute();

			if (manifest.items.length > 0) {
				const items = manifest.items.map((item) => ({
					id: randomUUID(),
					export_run_id: exportRunId,
					ledger_entry_id:
						contexts.find(
							(context) => context.row.canonical_key === item.canonicalKey,
						)?.row.id ?? null,
					canonical_key: item.canonicalKey,
					status: item.status,
					beancount_link: item.beancountLink,
					sidecar_reason: item.reason,
					payload_json: jsonText(item),
					created_at: generatedAt,
				}));
				await trx.insertInto("finance_export_items").values(items).execute();
			}
		});
	};

	try {
		mkdirSync(resolve(tempDir, "documents"), { recursive: true });
		const copiedDocuments = new Map<string, string>();
		const documentsMeta = {
			copied: new Map<string, DocumentCopiedMeta>(),
			missing: new Map<string, DocumentMissingMeta>(),
		};
		const documentsInManifest = new Set<string>();
		const renderedTransactions: RenderedExportTransaction[] = [];
		const items: Array<{
			canonicalKey: string;
			status: "exported" | "unresolved";
			sourceKind: "ledger_entry" | "raw_sidecar";
			beancountDate: string | null;
			beancountDateSource: "occurred_at" | "posted_at" | "cleared_at" | null;
			dateRecovery: Record<string, unknown> | null;
			beancountLink: string | null;
			messageId: string | null;
			sourceImportId: string | null;
			reason: string | null;
		}> = [];
		const rowRecords: Array<{
			ledgerEntry: Record<string, unknown>;
			source: {
				ledgerEntrySource: Record<string, unknown> | null;
				importRun: Record<string, unknown> | null;
				importDocument: Record<string, unknown> | null;
			} | null;
			eligibility: {
				exportable: boolean;
				reasons: string[];
				beancountDate: string | null;
				beancountDateSource: "occurred_at" | "posted_at" | "cleared_at" | null;
				dateRecovery: Record<string, unknown> | null;
				confidenceUsed: number | null;
				threshold: number;
			};
			export: {
				status: "exported" | "unresolved";
				generatedFile: string | null;
				beancountLink: string | null;
			};
			documents: {
				emitted: string[];
				missing: string[];
			};
		}> = [];
		const generatedFileBodies = new Map<number, string[]>();

		for (const year of years.length > 0 ? years : [defaultYear]) {
			generatedFileBodies.set(year, []);
		}

		for (const context of contexts) {
			const entryYear =
				deriveLedgerYear(context.row, context.eligibility) ?? defaultYear;
			const generatedFile = `generated/${entryYear}.beancount`;
			let beancountLink: string | null = null;
			let documentEmission: DocumentEmission = {
				relativePaths: [],
				lines: [],
				missing: [],
			};

			if (context.eligibility.exportable) {
				const rendered = renderTransaction({
					context,
					exportRunId,
				});
				beancountLink = rendered.beancountLink;
				generatedFileBodies.get(entryYear)?.push(rendered.body);
				renderedTransactions.push({
					canonicalKey: context.row.canonical_key,
					beancountDate: context.eligibility.beancountDate ?? "",
					generatedFile,
					beancountLink,
					body: rendered.body,
				});
				documentEmission = prepareDocumentEmission(
					context,
					tempDir,
					copiedDocuments,
					documentsMeta,
				);
				for (const relativePath of documentEmission.relativePaths) {
					documentsInManifest.add(relativePath);
				}
				if (documentEmission.lines.length > 0) {
					generatedFileBodies
						.get(entryYear)
						?.push(documentEmission.lines.join("\n"));
				}
			}

			items.push({
				canonicalKey: context.row.canonical_key,
				status: context.eligibility.exportable ? "exported" : "unresolved",
				sourceKind: context.eligibility.exportable
					? "ledger_entry"
					: "raw_sidecar",
				beancountDate: context.eligibility.beancountDate,
				beancountDateSource: context.eligibility.beancountDateSource,
				dateRecovery: context.eligibility.dateRecovery,
				beancountLink,
				messageId: context.source?.message_id ?? null,
				sourceImportId: context.source?.import_run_id ?? null,
				reason: context.eligibility.exportable
					? null
					: context.eligibility.reasons.join(";"),
			});

			rowRecords.push({
				ledgerEntry: safeJsonParse<Record<string, unknown>>(
					JSON.stringify(context.row),
					{},
				),
				source:
					context.source || context.importRun || context.importDocument
						? {
								ledgerEntrySource: context.source
									? safeJsonParse<Record<string, unknown>>(
											JSON.stringify(context.source),
											{},
										)
									: null,
								importRun: context.importRun
									? safeJsonParse<Record<string, unknown>>(
											JSON.stringify(context.importRun),
											{},
										)
									: null,
								importDocument: context.importDocument
									? safeJsonParse<Record<string, unknown>>(
											JSON.stringify({
												...context.importDocument,
												payload: safeJsonParse<Record<string, unknown>>(
													context.importDocument.payload_json,
													{},
												),
											}),
											{},
										)
									: null,
							}
						: null,
				eligibility: {
					exportable: context.eligibility.exportable,
					reasons: [...context.eligibility.reasons],
					beancountDate: context.eligibility.beancountDate,
					beancountDateSource: context.eligibility.beancountDateSource,
					dateRecovery: context.eligibility.dateRecovery,
					confidenceUsed: context.eligibility.confidenceUsed,
					threshold: context.eligibility.threshold,
				},
				export: {
					status: context.eligibility.exportable ? "exported" : "unresolved",
					generatedFile: context.eligibility.exportable ? generatedFile : null,
					beancountLink,
				},
				documents: {
					emitted: documentEmission.relativePaths,
					missing: documentEmission.missing.map(
						(missing) => missing.sourcePath,
					),
				},
			});
		}

		const generatedFiles = Array.from(generatedFileBodies.entries())
			.sort((left, right) => left[0] - right[0])
			.map(([year, parts]) => ({
				relativePath: `generated/${year}.beancount`,
				body:
					parts.join("\n") || "; no exportable zmail finance ledger entries\n",
			}));
		const accountsBody = renderAccounts(exportable, defaultYear);
		const mainBody = renderMain(
			generatedFiles.map((file) => file.relativePath),
			exportableCurrencies(exportable),
		);
		const unresolvedBody = unresolvedCsv(unresolved);
		const mainPath = resolve(tempDir, "main.beancount");
		const packageReadiness = summarizeExportReadiness(contexts);

		const validationStub = {
			beanCheck: "skipped" as const,
			beanCheckOutput: null as string | null,
			favaSmoke: "manual" as const,
		};

		packageJson = financeLedgerExportV2Schema.parse({
			schemaVersion: "finance-ledger-export.v2",
			orgId: input.orgId,
			exportRunId,
			generatedAt,
			strict: input.strict,
			year: input.year ?? null,
			years,
			files: {
				main: "main.beancount",
				accounts: "accounts.beancount",
				generated: generatedFiles.map((file) => file.relativePath),
				raw: "raw/zmail-finance-export.json",
				unresolved: "review/unresolved.csv",
				documents: Array.from(documentsInManifest).sort(),
			},
			readiness: packageReadiness,
			items,
			rows: rowRecords,
			documentsMeta: {
				pathMode: "import_run_source_file",
				copied: Array.from(documentsMeta.copied.values()).sort((left, right) =>
					left.relativePath.localeCompare(right.relativePath),
				),
				missing: Array.from(documentsMeta.missing.values()).sort(
					(left, right) => left.sourcePath.localeCompare(right.sourcePath),
				),
			},
			validation: validationStub,
		});

		writePackageFiles({
			packageDir: tempDir,
			accountsBody,
			generatedFiles,
			mainBody,
			unresolvedBody,
			manifestBody: `${JSON.stringify(packageJson, null, 2)}\n`,
		});

		internalValidation = runInternalExportValidation({
			packageDir: tempDir,
			manifest: packageJson,
			generatedFiles,
			exportedTransactions: renderedTransactions,
			exportedRowCount: exportable.length,
			unresolvedRowCount: unresolved.length,
		});
		if (internalValidation.status === "failed") {
			packageJson = financeLedgerExportV2Schema.parse({
				...packageJson,
				validation: {
					internal: internalValidation,
					beanCheck: "skipped",
					beanCheckOutput: "internal validation failed",
					favaSmoke: "skipped",
				},
			});
			writeFileSync(
				resolve(tempDir, "raw", "zmail-finance-export.json"),
				`${JSON.stringify(packageJson, null, 2)}\n`,
				"utf8",
			);
			finalStatus = "validation_failed";
			await persistExportRun(finalStatus, packageJson);
			const failedChecks = internalValidation.checks
				.filter((check) => check.status === "failed")
				.map((check) => check.name)
				.join(", ");
			throw new Error(
				`Finance export internal validation failed: ${failedChecks}`,
			);
		}

		validation = runBeanCheck(mainPath);
		packageJson = financeLedgerExportV2Schema.parse({
			...packageJson,
			validation: {
				internal: internalValidation,
				beanCheck: validation.status,
				beanCheckOutput: validation.output,
				favaSmoke: "manual",
			},
		});
		writeFileSync(
			resolve(tempDir, "raw", "zmail-finance-export.json"),
			`${JSON.stringify(packageJson, null, 2)}\n`,
			"utf8",
		);

		commitPackageDirectory({
			tempDir,
			outDir,
			force: input.force,
		});
		finalStatus =
			validation.status === "failed" ? "validation_failed" : "complete";
	} catch (error) {
		rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}

	if (!validation || !internalValidation || !packageJson || !finalStatus) {
		throw new Error("Finance export package generation did not complete.");
	}

	await persistExportRun(finalStatus, packageJson);

	const generatedPaths = packageJson.files.generated.map((file) =>
		resolve(outDir, file),
	);

	return {
		exportRunId,
		outDir,
		mainPath: resolve(outDir, "main.beancount"),
		accountsPath: resolve(outDir, "accounts.beancount"),
		generatedPath: generatedPaths[0] ?? null,
		generatedPaths,
		rawPath: resolve(outDir, "raw", "zmail-finance-export.json"),
		unresolvedPath: resolve(outDir, "review", "unresolved.csv"),
		exported: packageJson.items.filter((item) => item.status === "exported")
			.length,
		unresolved: packageJson.items.filter((item) => item.status === "unresolved")
			.length,
		validation: packageJson.validation,
	};
}

export function readFinanceExportManifest(path: string) {
	return safeJsonParse(loadFileText(path), null);
}
