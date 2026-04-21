import { randomUUID } from "node:crypto";

import { nowIso } from "#/lib/config";
import { getDb, safeJsonParse } from "#/lib/db";

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
	counterparty: string | null;
	status: string;
	canonicalKey: string;
	book: string;
	accountMappingKey: string | null;
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

function isRollupEligible(entry: FinanceLedgerEntry) {
	return entry.status === "ready" || entry.status === "review";
}

function isRollupMoneyDirection(direction: string) {
	return direction === "income" || direction === "expense";
}

export async function loadCombinedFinanceLedger() {
	const db = getDb();
	const rows = await db
		.selectFrom("finance_ledger_entries")
		.leftJoin(
			"finance_ledger_entry_sources",
			"finance_ledger_entry_sources.ledger_entry_id",
			"finance_ledger_entries.id",
		)
		.leftJoin(
			"messages",
			"messages.id",
			"finance_ledger_entry_sources.message_id",
		)
		.select([
			"finance_ledger_entries.id",
			"finance_ledger_entries.canonical_key",
			"finance_ledger_entries.status",
			"finance_ledger_entries.source_authority",
			"finance_ledger_entries.occurred_at",
			"finance_ledger_entries.posted_at",
			"finance_ledger_entries.direction",
			"finance_ledger_entries.amount_minor",
			"finance_ledger_entries.counterparty",
			"finance_ledger_entries.description",
			"finance_ledger_entries.book",
			"finance_ledger_entries.account_mapping_key",
			"finance_ledger_entries.ledger_metadata_json",
			"messages.account_id",
		])
		.orderBy("finance_ledger_entries.occurred_at", "desc")
		.orderBy("finance_ledger_entries.posted_at", "desc")
		.execute();

	const seen = new Set<string>();
	const entries: FinanceLedgerEntry[] = [];
	for (const row of rows) {
		if (seen.has(row.id)) {
			continue;
		}
		seen.add(row.id);
		const occurredAt = row.occurred_at ?? row.posted_at;
		const year = extractYear(occurredAt);
		if (!year) {
			continue;
		}
		const metadata = safeJsonParse<{
			categoryPrimary?: string | null;
			categorySecondary?: string | null;
			ownerIdentityId?: string | null;
			institutionId?: string | null;
			financialAccountId?: string | null;
		}>(row.ledger_metadata_json, {});
		entries.push({
			sourceKind: row.source_authority,
			year,
			accountId: row.account_id,
			primaryCategory: metadata.categoryPrimary ?? "uncategorized",
			secondaryCategory: metadata.categorySecondary ?? null,
			direction: row.direction,
			amountMinor: row.amount_minor,
			occurredAt,
			ownerIdentityId: metadata.ownerIdentityId ?? null,
			institutionId: metadata.institutionId ?? null,
			financialAccountId: metadata.financialAccountId ?? null,
			description: row.counterparty ?? row.description,
			counterparty: row.counterparty,
			status: row.status,
			canonicalKey: row.canonical_key,
			book: row.book,
			accountMappingKey: row.account_mapping_key,
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
		if (!isRollupEligible(entry) || !isRollupMoneyDirection(entry.direction)) {
			continue;
		}
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

		const amount = Math.abs(entry.amountMinor ?? 0);
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
			if (
				!isRollupEligible(entry) ||
				!isRollupMoneyDirection(entry.direction)
			) {
				return acc;
			}
			const amount = Math.abs(entry.amountMinor ?? 0);
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

	return {
		summary,
		rollups: [...yearly.values()].sort(sortRollup),
		subcategoryRollups: [...subcategory.values()].sort(sortSubcategoryRollup),
	};
}

function sortRollup(left: FinancePrimaryRollup, right: FinancePrimaryRollup) {
	if (left.year !== right.year) {
		return right.year - left.year;
	}
	if (left.sourceKind !== right.sourceKind) {
		return left.sourceKind.localeCompare(right.sourceKind);
	}
	return left.primaryCategory.localeCompare(right.primaryCategory);
}

function sortSubcategoryRollup(
	left: FinanceSubcategoryRollup,
	right: FinanceSubcategoryRollup,
) {
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
