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

export async function rebuildFinanceRollups() {
	const db = getDb();
	const ledger = await loadCombinedFinanceLedger();
	const importDocuments = await db
		.selectFrom("finance_import_documents")
		.select(["statement_period_end"])
		.execute();

	const yearly = new Map<
		string,
		{
			id: string;
			year: number;
			source_kind: string;
			primary_category: string;
			inflow_minor: number;
			outflow_minor: number;
			net_minor: number;
			transaction_count: number;
			imported_statement_count: number;
			extracted_transaction_count: number;
			uncategorized_count: number;
			created_at: string;
			updated_at: string;
		}
	>();
	const subcategory = new Map<
		string,
		{
			id: string;
			year: number;
			source_kind: string;
			primary_category: string;
			secondary_category: string;
			inflow_minor: number;
			outflow_minor: number;
			net_minor: number;
			transaction_count: number;
			created_at: string;
			updated_at: string;
		}
	>();
	const now = nowIso();

	for (const entry of ledger) {
		const yearlyKey = `${entry.year}:${entry.sourceKind}:${entry.primaryCategory}`;
		const currentYearly = yearly.get(yearlyKey) ?? {
			id: randomUUID(),
			year: entry.year,
			source_kind: entry.sourceKind,
			primary_category: entry.primaryCategory,
			inflow_minor: 0,
			outflow_minor: 0,
			net_minor: 0,
			transaction_count: 0,
			imported_statement_count: 0,
			extracted_transaction_count: 0,
			uncategorized_count: 0,
			created_at: now,
			updated_at: now,
		};

		const amount = entry.amountMinor ?? 0;
		if (entry.direction === "income") {
			currentYearly.inflow_minor += amount;
			currentYearly.net_minor += amount;
		} else if (entry.direction === "expense") {
			currentYearly.outflow_minor += amount;
			currentYearly.net_minor -= amount;
		}
		currentYearly.transaction_count += 1;
		currentYearly.extracted_transaction_count += 1;
		if (entry.primaryCategory === "uncategorized") {
			currentYearly.uncategorized_count += 1;
		}
		yearly.set(yearlyKey, currentYearly);

		const secondaryCategory = entry.secondaryCategory ?? "uncategorized";
		const subcategoryKey = `${entry.year}:${entry.sourceKind}:${entry.primaryCategory}:${secondaryCategory}`;
		const currentSubcategory = subcategory.get(subcategoryKey) ?? {
			id: randomUUID(),
			year: entry.year,
			source_kind: entry.sourceKind,
			primary_category: entry.primaryCategory,
			secondary_category: secondaryCategory,
			inflow_minor: 0,
			outflow_minor: 0,
			net_minor: 0,
			transaction_count: 0,
			created_at: now,
			updated_at: now,
		};
		if (entry.direction === "income") {
			currentSubcategory.inflow_minor += amount;
			currentSubcategory.net_minor += amount;
		} else if (entry.direction === "expense") {
			currentSubcategory.outflow_minor += amount;
			currentSubcategory.net_minor -= amount;
		}
		currentSubcategory.transaction_count += 1;
		subcategory.set(subcategoryKey, currentSubcategory);
	}

	for (const row of importDocuments) {
		const year = extractYear(row.statement_period_end);
		if (!year) {
			continue;
		}
		const key = `${year}:statement:uncategorized`;
		const current = yearly.get(key) ?? {
			id: randomUUID(),
			year,
			source_kind: "statement",
			primary_category: "uncategorized",
			inflow_minor: 0,
			outflow_minor: 0,
			net_minor: 0,
			transaction_count: 0,
			imported_statement_count: 0,
			extracted_transaction_count: 0,
			uncategorized_count: 0,
			created_at: now,
			updated_at: now,
		};
		current.imported_statement_count += 1;
		yearly.set(key, current);
	}

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("finance_yearly_subcategory_rollups").execute();
		await trx.deleteFrom("finance_yearly_rollups").execute();
		if (yearly.size > 0) {
			await trx
				.insertInto("finance_yearly_rollups")
				.values([...yearly.values()])
				.execute();
		}
		if (subcategory.size > 0) {
			await trx
				.insertInto("finance_yearly_subcategory_rollups")
				.values([...subcategory.values()])
				.execute();
		}
	});

	return {
		years: new Set(ledger.map((entry) => entry.year)).size,
		rollups: yearly.size,
		subcategoryRollups: subcategory.size,
	};
}
