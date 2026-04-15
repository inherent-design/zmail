import { randomUUID } from "node:crypto";

import { nowIso } from "#/lib/config";
import { getDb, safeJsonParse } from "#/lib/db";
import { parseAmountMinor } from "#/lib/finance-imports";
import { normalizeFinanceIntel } from "#/lib/schemas";

function extractYear(value: string | null | undefined) {
	if (!value) {
		return null;
	}
	const match = /^(\d{4})/.exec(value);
	return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

export interface FinanceLedgerEntry {
	sourceKind: string;
	year: number;
	accountId: string | null;
	primaryCategory: string;
	secondaryCategory: string | null;
	direction: string;
	amountMinor: number | null;
	occurredAt: string | null;
	ownerIdentityId: string | null;
	institutionId: string | null;
	financialAccountId: string | null;
	description: string | null;
}

export interface FinanceImportDocumentEntry {
	sourceKind: string;
	statementPeriodEnd: string | null;
}

export interface FinanceSummary {
	inflowMinor: number;
	outflowMinor: number;
	netMinor: number;
	importedStatementCount: number;
	extractedTransactionCount: number;
	uncategorizedCount: number;
}

export interface FinancePrimaryRollup {
	year: number;
	sourceKind: string;
	primaryCategory: string;
	inflowMinor: number;
	outflowMinor: number;
	netMinor: number;
	transactionCount: number;
	importedStatementCount: number;
	extractedTransactionCount: number;
	uncategorizedCount: number;
}

export interface FinanceSubcategoryRollup {
	year: number;
	sourceKind: string;
	primaryCategory: string;
	secondaryCategory: string;
	inflowMinor: number;
	outflowMinor: number;
	netMinor: number;
	transactionCount: number;
}

export async function loadCombinedFinanceLedger() {
	const db = getDb();
	const [emailRows, importRows] = await Promise.all([
		db
			.selectFrom("message_secondary_heads")
			.innerJoin(
				"message_secondary_results",
				"message_secondary_results.id",
				"message_secondary_heads.secondary_result_id",
			)
			.innerJoin(
				"messages",
				"messages.id",
				"message_secondary_heads.message_id",
			)
			.select([
				"message_secondary_results.result_json",
				"messages.received_at",
				"messages.account_id",
			])
			.where("message_secondary_heads.classifier_key", "=", "finance_intel")
			.where("message_secondary_heads.status", "in", ["ready", "review"])
			.execute(),
		db
			.selectFrom("finance_import_transactions")
			.innerJoin(
				"finance_import_runs",
				"finance_import_runs.id",
				"finance_import_transactions.import_run_id",
			)
			.select([
				"finance_import_transactions.id",
				"finance_import_transactions.import_run_id",
				"finance_import_transactions.source_document_ref",
				"finance_import_transactions.occurred_at",
				"finance_import_transactions.posted_at",
				"finance_import_transactions.amount_value",
				"finance_import_transactions.amount_minor",
				"finance_import_transactions.currency",
				"finance_import_transactions.direction",
				"finance_import_transactions.description",
				"finance_import_transactions.merchant_or_counterparty",
				"finance_import_transactions.balance_value",
				"finance_import_transactions.owner_identity_hint",
				"finance_import_transactions.financial_account_hint",
				"finance_import_transactions.institution_hint",
				"finance_import_transactions.category_primary",
				"finance_import_transactions.category_secondary",
				"finance_import_runs.source_kind as import_source_kind",
			])
			.execute(),
	]);

	const entries: FinanceLedgerEntry[] = [];
	for (const row of emailRows) {
		const financeIntel = normalizeFinanceIntel(
			safeJsonParse(row.result_json, null),
		);
		if (!financeIntel) {
			continue;
		}
		for (const transaction of financeIntel.transactionCandidates) {
			const year =
				extractYear(transaction.occurredAt) ?? extractYear(row.received_at);
			if (!year) {
				continue;
			}
			entries.push({
				sourceKind: "email",
				year,
				accountId: row.account_id,
				primaryCategory: transaction.categoryPrimary ?? "uncategorized",
				secondaryCategory: transaction.categorySecondary,
				direction: transaction.direction,
				amountMinor: parseAmountMinor(transaction.amount),
				occurredAt: transaction.occurredAt,
				ownerIdentityId: transaction.ownerIdentityRef,
				institutionId: transaction.institutionRef,
				financialAccountId: transaction.financialAccountRef,
				description: transaction.merchantOrCounterparty,
			});
		}
	}

	for (const row of importRows) {
		const year = extractYear(row.occurred_at) ?? extractYear(row.posted_at);
		if (!year) {
			continue;
		}
		entries.push({
			sourceKind: row.import_source_kind,
			year,
			accountId: null,
			primaryCategory: row.category_primary ?? "uncategorized",
			secondaryCategory: row.category_secondary,
			direction: row.direction,
			amountMinor: row.amount_minor,
			occurredAt: row.occurred_at,
			ownerIdentityId: row.owner_identity_hint,
			institutionId: row.institution_hint,
			financialAccountId: row.financial_account_hint,
			description: row.merchant_or_counterparty ?? row.description,
		});
	}

	return entries;
}

export function buildFinanceRollupView(input: {
	ledger: FinanceLedgerEntry[];
	importDocuments: FinanceImportDocumentEntry[];
}) {
	const yearly = new Map<string, FinancePrimaryRollup>();
	const subcategory = new Map<string, FinanceSubcategoryRollup>();

	for (const entry of input.ledger) {
		const yearlyKey = `${entry.year}:${entry.sourceKind}:${entry.primaryCategory}`;
		const currentYearly = yearly.get(yearlyKey) ?? {
			year: entry.year,
			sourceKind: entry.sourceKind,
			primaryCategory: entry.primaryCategory,
			inflowMinor: 0,
			outflowMinor: 0,
			netMinor: 0,
			transactionCount: 0,
			importedStatementCount: 0,
			extractedTransactionCount: 0,
			uncategorizedCount: 0,
		};

		const amount = entry.amountMinor ?? 0;
		if (entry.direction === "income") {
			currentYearly.inflowMinor += amount;
			currentYearly.netMinor += amount;
		} else if (entry.direction === "expense") {
			currentYearly.outflowMinor += amount;
			currentYearly.netMinor -= amount;
		}
		currentYearly.transactionCount += 1;
		currentYearly.extractedTransactionCount += 1;
		if (entry.primaryCategory === "uncategorized") {
			currentYearly.uncategorizedCount += 1;
		}
		yearly.set(yearlyKey, currentYearly);

		const secondaryCategory = entry.secondaryCategory ?? "uncategorized";
		const subcategoryKey = `${entry.year}:${entry.sourceKind}:${entry.primaryCategory}:${secondaryCategory}`;
		const currentSubcategory = subcategory.get(subcategoryKey) ?? {
			year: entry.year,
			sourceKind: entry.sourceKind,
			primaryCategory: entry.primaryCategory,
			secondaryCategory,
			inflowMinor: 0,
			outflowMinor: 0,
			netMinor: 0,
			transactionCount: 0,
		};
		if (entry.direction === "income") {
			currentSubcategory.inflowMinor += amount;
			currentSubcategory.netMinor += amount;
		} else if (entry.direction === "expense") {
			currentSubcategory.outflowMinor += amount;
			currentSubcategory.netMinor -= amount;
		}
		currentSubcategory.transactionCount += 1;
		subcategory.set(subcategoryKey, currentSubcategory);
	}

	for (const row of input.importDocuments) {
		const year = extractYear(row.statementPeriodEnd);
		if (!year) {
			continue;
		}
		const sourceKind = row.sourceKind || "statement";
		const key = `${year}:${sourceKind}:uncategorized`;
		const current = yearly.get(key) ?? {
			year,
			sourceKind,
			primaryCategory: "uncategorized",
			inflowMinor: 0,
			outflowMinor: 0,
			netMinor: 0,
			transactionCount: 0,
			importedStatementCount: 0,
			extractedTransactionCount: 0,
			uncategorizedCount: 0,
		};
		current.importedStatementCount += 1;
		yearly.set(key, current);
	}

	const summary = input.ledger.reduce<FinanceSummary>(
		(acc, entry) => {
			const amount = entry.amountMinor ?? 0;
			if (entry.direction === "income") {
				acc.inflowMinor += amount;
				acc.netMinor += amount;
			} else if (entry.direction === "expense") {
				acc.outflowMinor += amount;
				acc.netMinor -= amount;
			}
			acc.extractedTransactionCount += 1;
			if (entry.primaryCategory === "uncategorized") {
				acc.uncategorizedCount += 1;
			}
			return acc;
		},
		{
			inflowMinor: 0,
			outflowMinor: 0,
			netMinor: 0,
			importedStatementCount: input.importDocuments.length,
			extractedTransactionCount: 0,
			uncategorizedCount: 0,
		},
	);

	const rollups = [...yearly.values()].sort((left, right) => {
		if (left.year !== right.year) {
			return right.year - left.year;
		}
		if (left.sourceKind !== right.sourceKind) {
			return left.sourceKind.localeCompare(right.sourceKind);
		}
		return left.primaryCategory.localeCompare(right.primaryCategory);
	});
	const subcategoryRollups = [...subcategory.values()].sort((left, right) => {
		if (left.year !== right.year) {
			return right.year - left.year;
		}
		if (left.sourceKind !== right.sourceKind) {
			return left.sourceKind.localeCompare(right.sourceKind);
		}
		if (left.primaryCategory !== right.primaryCategory) {
			return left.primaryCategory.localeCompare(right.primaryCategory);
		}
		return left.secondaryCategory.localeCompare(right.secondaryCategory);
	});

	return {
		summary,
		rollups,
		subcategoryRollups,
	};
}

export async function rebuildFinanceRollups() {
	const db = getDb();
	const ledger = await loadCombinedFinanceLedger();
	const importDocuments = await db
		.selectFrom("finance_import_documents")
		.innerJoin(
			"finance_import_runs",
			"finance_import_runs.id",
			"finance_import_documents.import_run_id",
		)
		.select([
			"finance_import_documents.statement_period_end",
			"finance_import_runs.source_kind as source_kind",
		])
		.execute();
	const now = nowIso();
	const view = buildFinanceRollupView({
		ledger,
		importDocuments: importDocuments.map((row) => ({
			sourceKind: row.source_kind,
			statementPeriodEnd: row.statement_period_end,
		})),
	});

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("finance_yearly_subcategory_rollups").execute();
		await trx.deleteFrom("finance_yearly_rollups").execute();
		if (view.rollups.length > 0) {
			await trx
				.insertInto("finance_yearly_rollups")
				.values(
					view.rollups.map((row) => ({
						id: randomUUID(),
						year: row.year,
						source_kind: row.sourceKind,
						primary_category: row.primaryCategory,
						inflow_minor: row.inflowMinor,
						outflow_minor: row.outflowMinor,
						net_minor: row.netMinor,
						transaction_count: row.transactionCount,
						imported_statement_count: row.importedStatementCount,
						extracted_transaction_count: row.extractedTransactionCount,
						uncategorized_count: row.uncategorizedCount,
						created_at: now,
						updated_at: now,
					})),
				)
				.execute();
		}
		if (view.subcategoryRollups.length > 0) {
			await trx
				.insertInto("finance_yearly_subcategory_rollups")
				.values(
					view.subcategoryRollups.map((row) => ({
						id: randomUUID(),
						year: row.year,
						source_kind: row.sourceKind,
						primary_category: row.primaryCategory,
						secondary_category: row.secondaryCategory,
						inflow_minor: row.inflowMinor,
						outflow_minor: row.outflowMinor,
						net_minor: row.netMinor,
						transaction_count: row.transactionCount,
						created_at: now,
						updated_at: now,
					})),
				)
				.execute();
		}
	});

	return {
		years: new Set(ledger.map((entry) => entry.year)).size,
		rollups: view.rollups.length,
		subcategoryRollups: view.subcategoryRollups.length,
	};
}
