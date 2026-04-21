import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { APP_CONFIG, nowIso, PROMPTS_DIR } from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { parseAmountMinor } from "#/lib/finance-imports";
import { queueJobIdempotent } from "#/lib/jobs";
import { piJson } from "#/lib/pi";
import { publishActionEvent } from "#/lib/runtime-events";
import {
	type FinanceAccountMapping,
	type FinanceAccountMappingSuggestion,
	type FinanceBookScope,
	financeAccountMappingSuggestionSchema,
} from "#/lib/schemas";

type DirectionTotals =
	FinanceAccountMappingSuggestion["impact"]["totalMinorByDirection"];

const overseerAdjustmentSchema = z.object({
	confidenceDelta: z.number().min(-0.2).max(0.2).default(0),
	reasons: z.array(z.string().min(1).max(240)).max(10).default([]),
	requiresReview: z.boolean().default(true),
});

interface CandidateSource {
	messageId: string | null;
	accountId: string | null;
	sourceKind: string;
	senderAddress: string | null;
	subject: string | null;
}

interface CandidateLedgerRow {
	id: string;
	canonicalKey: string;
	status: string;
	occurredAt: string | null;
	postedAt: string | null;
	clearedAt: string | null;
	description: string | null;
	counterparty: string | null;
	direction: string;
	amountValue: string | null;
	amountMinor: number | null;
	currency: string | null;
	book: FinanceBookScope;
	businessUsePercent: number | null;
	accountMappingKey: string | null;
	debitAccount: string | null;
	creditAccount: string | null;
	fieldConfidence: Record<string, unknown>;
	metadata: {
		categoryPrimary?: string | null;
		categorySecondary?: string | null;
		ownerIdentityId?: string | null;
		institutionId?: string | null;
		financialAccountId?: string | null;
	};
	sources: CandidateSource[];
}

interface GenerateFinanceMappingCandidatesInput {
	year?: number | null;
	minConfidenceToPersist?: number;
	autoApplyThreshold?: number;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 20) {
	return Array.from(
		new Set(
			values
				.map((value) => value?.trim() ?? "")
				.filter((value) => value.length > 0),
		),
	)
		.sort((left, right) => left.localeCompare(right))
		.slice(0, limit);
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

export async function loadFinanceMappingCandidateInputWatermark() {
	const db = getDb();
	const [ledgerState, mappingState, suggestionState, overseerState] =
		await Promise.all([
			db
				.selectFrom("finance_ledger_entries")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("finance_account_mappings")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("registry_suggestions")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("overseer_profiles")
				.select((eb) => eb.fn.max("created_at").as("created_at"))
				.executeTakeFirstOrThrow(),
		]);
	return maxIsoValue([
		ledgerState.updated_at ?? null,
		mappingState.updated_at ?? null,
		suggestionState.updated_at ?? null,
		overseerState.created_at ?? null,
	]);
}

function extractDomain(value: string | null | undefined) {
	if (!value || !value.includes("@")) {
		return null;
	}
	const parts = value.toLowerCase().split("@");
	return parts[parts.length - 1] || null;
}

function slug(value: string | null | undefined, fallback = "unknown") {
	const normalized = (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || fallback;
}

function titlePart(
	value: string | null | undefined,
	fallback = "Uncategorized",
) {
	return slug(value, fallback.toLowerCase())
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function ledgerDate(row: CandidateLedgerRow) {
	return row.occurredAt ?? row.postedAt ?? row.clearedAt;
}

function rowYear(row: CandidateLedgerRow) {
	const date = ledgerDate(row);
	if (!date) {
		return null;
	}
	const year = Number.parseInt(date.slice(0, 4), 10);
	return Number.isInteger(year) ? year : null;
}

function amountMinor(row: CandidateLedgerRow) {
	return row.amountMinor ?? parseAmountMinor(row.amountValue);
}

function primaryCategory(row: CandidateLedgerRow) {
	return row.metadata.categoryPrimary ?? "uncategorized";
}

function secondaryCategory(row: CandidateLedgerRow) {
	return row.metadata.categorySecondary ?? null;
}

function categoryKey(row: CandidateLedgerRow) {
	const primary = primaryCategory(row);
	const secondary = secondaryCategory(row);
	return secondary ? `${primary}/${secondary}` : primary;
}

function isCountableDirection(direction: string) {
	return direction === "expense" || direction === "income";
}

function canBecomeReadyWithMapping(row: CandidateLedgerRow) {
	return (
		isCountableDirection(row.direction) &&
		amountMinor(row) !== null &&
		Boolean(row.currency) &&
		Boolean(ledgerDate(row)) &&
		Boolean(row.counterparty) &&
		row.book !== "unknown" &&
		(row.book !== "mixed" || row.businessUsePercent !== null)
	);
}

function senderDomains(rows: CandidateLedgerRow[]) {
	return uniqueStrings(
		rows.flatMap((row) =>
			row.sources.map((source) => extractDomain(source.senderAddress)),
		),
	);
}

function sampleMessageIds(rows: CandidateLedgerRow[]) {
	return uniqueStrings(
		rows.flatMap((row) => row.sources.map((source) => source.messageId)),
		10,
	);
}

function evidenceAccounts(rows: CandidateLedgerRow[]) {
	const text = rows
		.flatMap((row) => [
			row.description,
			row.counterparty,
			row.metadata.financialAccountId,
			row.metadata.institutionId,
			row.metadata.ownerIdentityId,
			...row.sources.flatMap((source) => [source.subject]),
		])
		.filter((value): value is string => Boolean(value))
		.join("\n");
	const last4 = Array.from(
		text.matchAll(/(?:ending|last4|account)[^0-9]{0,16}([0-9]{4})/gi),
	)
		.map((match) => (match[1] ? `last4:${match[1]}` : null))
		.filter((value): value is string => Boolean(value));
	return uniqueStrings([
		...rows.map((row) => row.metadata.financialAccountId),
		...rows.map((row) => row.metadata.institutionId),
		...last4,
	]);
}

function directionTotals(rows: CandidateLedgerRow[]): DirectionTotals {
	const totals: DirectionTotals = {
		expense: 0,
		income: 0,
		both: 0,
		neither: 0,
		unknown: 0,
	};
	for (const row of rows) {
		const amount = Math.abs(amountMinor(row) ?? 0);
		if (row.direction === "expense") {
			totals.expense += amount;
		} else if (row.direction === "income") {
			totals.income += amount;
		} else if (row.direction === "both") {
			totals.both += amount;
		} else if (row.direction === "neither") {
			totals.neither += amount;
		} else {
			totals.unknown += amount;
		}
	}
	return totals;
}

function beancountBookPrefix(book: FinanceBookScope) {
	switch (book) {
		case "business":
			return "Business";
		case "personal":
			return "Personal";
		case "mixed":
			return "Mixed";
		default:
			return "Unknown";
	}
}

function expenseAccount(row: CandidateLedgerRow) {
	const book = beancountBookPrefix(row.book);
	switch (primaryCategory(row)) {
		case "payroll_contractors":
			return secondaryCategory(row) === "payroll"
				? `Expenses:${book}:Payroll`
				: `Expenses:${book}:ContractLabor`;
		case "insurance":
			return `Expenses:${book}:Insurance`;
		case "taxes":
			return `Expenses:${book}:TaxesAndLicenses`;
		case "travel":
			return `Expenses:${book}:Travel`;
		case "meals":
			return `Expenses:${book}:Meals`;
		case "utilities":
			return `Expenses:${book}:Utilities`;
		case "office_business":
			return `Expenses:${book}:Office`;
		case "shopping":
			return secondaryCategory(row) === "supplies"
				? `Expenses:${book}:Supplies`
				: `Expenses:${book}:Shopping`;
		case "software_services":
			return `Expenses:${book}:SoftwareServices`;
		case "subscriptions":
			return `Expenses:${book}:Subscriptions`;
		case "banking_fees":
			return `Expenses:${book}:BankFees`;
		case "education":
			return `Expenses:${book}:Education`;
		case "donations":
			return `Expenses:${book}:Donations`;
		default:
			return `Expenses:${book}:${titlePart(primaryCategory(row))}`;
	}
}

function incomeAccount(row: CandidateLedgerRow) {
	const book = beancountBookPrefix(row.book);
	return primaryCategory(row) === "income"
		? `Income:${book}:GrossReceipts`
		: `Income:${book}:${titlePart(primaryCategory(row))}`;
}

function sourceAccount(row: CandidateLedgerRow, accounts: string[]) {
	const book = beancountBookPrefix(row.book);
	const account = accounts.find((value) => !value.startsWith("last4:"));
	const last4 = accounts.find((value) => value.startsWith("last4:"));
	if (account) {
		return `Assets:${book}:${titlePart(account)}`;
	}
	if (last4) {
		return `Assets:${book}:Account${last4.slice("last4:".length)}`;
	}
	return `Assets:${book}:Unmapped`;
}

function mappingAccounts(row: CandidateLedgerRow, accounts: string[]) {
	if (row.direction === "income") {
		return {
			debitAccount: sourceAccount(row, accounts),
			creditAccount: incomeAccount(row),
		};
	}
	return {
		debitAccount: expenseAccount(row),
		creditAccount: sourceAccount(row, accounts),
	};
}

function clusterKeyForRow(row: CandidateLedgerRow) {
	const domain = senderDomains([row])[0] ?? "";
	const counterparty = slug(row.counterparty ?? row.description);
	const category = categoryKey(row);
	return [row.book, row.direction, category, domain || counterparty].join(":");
}

function mappingKeyForCluster(rows: CandidateLedgerRow[], clusterKey: string) {
	const first = rows[0];
	if (!first) {
		return `finance:${slug(clusterKey)}`;
	}
	const domain = senderDomains(rows)[0];
	const primary = primaryCategory(first);
	return [
		first.book,
		first.direction,
		primary,
		domain ? slug(domain) : slug(first.counterparty ?? first.description),
	]
		.filter(Boolean)
		.join(":")
		.slice(0, 240);
}

function mapProfileByAccount(
	rows: Array<{ account_id: string; profile_json: string }>,
) {
	const profiles = new Map<
		string,
		{ knownBusinessDomains?: string[]; knownPersonalDomains?: string[] }
	>();
	for (const row of rows) {
		if (profiles.has(row.account_id)) {
			continue;
		}
		profiles.set(
			row.account_id,
			safeJsonParse(row.profile_json, {}) as {
				knownBusinessDomains?: string[];
				knownPersonalDomains?: string[];
			},
		);
	}
	return profiles;
}

function confidenceForCluster(input: {
	rows: CandidateLedgerRow[];
	domains: string[];
	accounts: string[];
	reviewConfidence: number;
	overseerProfiles: Map<
		string,
		{ knownBusinessDomains?: string[]; knownPersonalDomains?: string[] }
	>;
}) {
	const first = input.rows[0];
	if (!first) {
		return { confidence: 0, reasons: ["empty cluster"] };
	}
	const reasons: string[] = [];
	let confidence = 0.55;
	if (isCountableDirection(first.direction)) {
		confidence += 0.1;
		reasons.push("countable direction");
	}
	if (first.book !== "unknown") {
		confidence += 0.08;
		reasons.push("known book");
	}
	if (primaryCategory(first) !== "uncategorized") {
		confidence += 0.08;
		reasons.push("known category");
	}
	if (input.domains.length === 1) {
		confidence += 0.08;
		reasons.push("single sender domain");
	}
	if (input.accounts.length > 0) {
		confidence += 0.04;
		reasons.push("account evidence");
	}
	if (input.rows.length >= 2) {
		confidence += 0.04;
		reasons.push("repeated cluster");
	}
	if (input.rows.length >= 5) {
		confidence += 0.04;
		reasons.push("material cluster");
	}
	if (input.reviewConfidence >= 0.9) {
		confidence += 0.06;
		reasons.push("review classifier mapping finding");
	}

	const accountIds = uniqueStrings(
		input.rows.flatMap((row) => row.sources.map((source) => source.accountId)),
	);
	const knownBusinessDomains = new Set<string>();
	const knownPersonalDomains = new Set<string>();
	for (const accountId of accountIds) {
		const profile = input.overseerProfiles.get(accountId);
		for (const domain of profile?.knownBusinessDomains ?? []) {
			knownBusinessDomains.add(domain);
		}
		for (const domain of profile?.knownPersonalDomains ?? []) {
			knownPersonalDomains.add(domain);
		}
	}
	const businessDomainMatch = input.domains.some((domain) =>
		knownBusinessDomains.has(domain),
	);
	const personalDomainMatch = input.domains.some((domain) =>
		knownPersonalDomains.has(domain),
	);
	if (first.book === "business" && businessDomainMatch) {
		confidence += 0.04;
		reasons.push("overseer business domain match");
	}
	if (first.book === "personal" && personalDomainMatch) {
		confidence += 0.04;
		reasons.push("overseer personal domain match");
	}
	if (first.book === "business" && personalDomainMatch) {
		confidence -= 0.12;
		reasons.push("overseer personal domain conflict");
	}
	if (first.book === "personal" && businessDomainMatch) {
		confidence -= 0.12;
		reasons.push("overseer business domain conflict");
	}

	if (input.rows.some((row) => !row.counterparty)) {
		confidence -= 0.06;
		reasons.push("counterparty gaps remain");
	}

	return {
		confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
		reasons,
	};
}

async function loadCandidateLedgerRows(input: { year?: number | null }) {
	const rows = await getDb()
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
			"finance_ledger_entries.id as id",
			"finance_ledger_entries.canonical_key as canonical_key",
			"finance_ledger_entries.status as status",
			"finance_ledger_entries.occurred_at as occurred_at",
			"finance_ledger_entries.posted_at as posted_at",
			"finance_ledger_entries.cleared_at as cleared_at",
			"finance_ledger_entries.description as description",
			"finance_ledger_entries.counterparty as counterparty",
			"finance_ledger_entries.direction as direction",
			"finance_ledger_entries.amount_value as amount_value",
			"finance_ledger_entries.amount_minor as amount_minor",
			"finance_ledger_entries.currency as currency",
			"finance_ledger_entries.book as book",
			"finance_ledger_entries.business_use_percent as business_use_percent",
			"finance_ledger_entries.account_mapping_key as account_mapping_key",
			"finance_ledger_entries.debit_account as debit_account",
			"finance_ledger_entries.credit_account as credit_account",
			"finance_ledger_entries.field_confidence_json as field_confidence_json",
			"finance_ledger_entries.ledger_metadata_json as ledger_metadata_json",
			"finance_ledger_entry_sources.source_kind as source_kind",
			"finance_ledger_entry_sources.message_id as message_id",
			"messages.account_id as account_id",
			"messages.sender_address as sender_address",
			"messages.subject as subject",
		])
		.where("finance_ledger_entries.status", "in", ["review", "blocked"])
		.orderBy("finance_ledger_entries.updated_at", "desc")
		.execute();

	const byId = new Map<string, CandidateLedgerRow>();
	for (const row of rows) {
		const existing = byId.get(row.id);
		const source: CandidateSource = {
			messageId: row.message_id,
			accountId: row.account_id,
			sourceKind: row.source_kind ?? "ledger",
			senderAddress: row.sender_address,
			subject: row.subject,
		};
		if (existing) {
			existing.sources.push(source);
			continue;
		}
		const ledgerRow: CandidateLedgerRow = {
			id: row.id,
			canonicalKey: row.canonical_key,
			status: row.status,
			occurredAt: row.occurred_at,
			postedAt: row.posted_at,
			clearedAt: row.cleared_at,
			description: row.description,
			counterparty: row.counterparty,
			direction: row.direction,
			amountValue: row.amount_value,
			amountMinor: row.amount_minor,
			currency: row.currency,
			book: row.book as FinanceBookScope,
			businessUsePercent: row.business_use_percent,
			accountMappingKey: row.account_mapping_key,
			debitAccount: row.debit_account,
			creditAccount: row.credit_account,
			fieldConfidence: safeJsonParse(row.field_confidence_json, {}),
			metadata: safeJsonParse(row.ledger_metadata_json, {}),
			sources: [source],
		};
		if (input.year && rowYear(ledgerRow) !== input.year) {
			continue;
		}
		if (
			ledgerRow.accountMappingKey &&
			ledgerRow.debitAccount &&
			ledgerRow.creditAccount
		) {
			continue;
		}
		byId.set(row.id, ledgerRow);
	}
	return [...byId.values()];
}

async function loadReviewMappingConfidence() {
	const rows = await getDb()
		.selectFrom("review_classification_heads")
		.select(["target_id", "confidence"])
		.where("target_kind", "=", "finance_ledger_entry")
		.where("action", "=", "mapping_needed")
		.where("status", "=", "open")
		.execute();
	const byTarget = new Map<string, number>();
	for (const row of rows) {
		byTarget.set(
			row.target_id,
			Math.max(byTarget.get(row.target_id) ?? 0, row.confidence),
		);
	}
	return byTarget;
}

function buildMappingSuggestion(input: {
	clusterKey: string;
	rows: CandidateLedgerRow[];
	confidence: number;
	reasons: string[];
	autoApplyThreshold: number;
	duplicateCanonicalKeys: string[];
}): FinanceAccountMappingSuggestion {
	const first = input.rows[0];
	if (!first) {
		throw new Error(
			"Cannot build finance mapping suggestion for empty cluster",
		);
	}
	const domains = senderDomains(input.rows);
	const accounts = evidenceAccounts(input.rows);
	const categories = uniqueStrings(input.rows.map(categoryKey));
	const match: Record<string, unknown> = {
		book: [first.book],
	};
	if (domains.length === 1) {
		match.senderDomain = domains;
	}
	const counterparty = uniqueStrings(
		input.rows.map((row) => row.counterparty ?? row.description),
		5,
	);
	if (counterparty.length === 1) {
		match.textIncludes = counterparty;
	}
	const last4 = accounts
		.filter((value) => value.startsWith("last4:"))
		.map((value) => value.slice("last4:".length));
	if (last4.length > 0) {
		match.accountLast4 = last4;
	}

	const accountsForPosting = mappingAccounts(first, accounts);
	const mapping: FinanceAccountMapping = {
		mappingKey: mappingKeyForCluster(input.rows, input.clusterKey),
		book: first.book,
		match,
		...accountsForPosting,
		currency: first.currency ?? "USD",
		confidence: input.confidence,
		notes:
			"Generated from unresolved finance ledger rows. Review posting accounts before filing-grade use.",
	};
	return financeAccountMappingSuggestionSchema.parse({
		schemaVersion: "finance-account-mapping-suggestion.v1",
		mapping,
		impact: {
			ledgerEntryIds: input.rows.map((row) => row.id),
			ledgerCanonicalKeys: input.rows.map((row) => row.canonicalKey),
			rowCount: input.rows.length,
			readyUnlockEstimate: input.rows.filter(canBecomeReadyWithMapping).length,
			totalMinorByDirection: directionTotals(input.rows),
		},
		evidence: {
			senderDomains: domains,
			counterparties: counterparty,
			books: uniqueStrings(input.rows.map((row) => row.book)).flatMap((book) =>
				["personal", "business", "mixed", "unknown"].includes(book)
					? [book]
					: [],
			),
			categories,
			accounts,
			sampleMessageIds: sampleMessageIds(input.rows),
		},
		dedupe: {
			clusterKey: input.clusterKey,
			duplicateCanonicalKeys: input.duplicateCanonicalKeys,
			confidenceReasons: input.reasons,
		},
		autoApplyEligible: input.confidence >= input.autoApplyThreshold,
	});
}

function suggestionRow(input: {
	entityKind: string;
	canonicalKey: string;
	payload: unknown;
	sourceRefId: string;
	confidence: number;
	createdAt: string;
}) {
	return {
		id: randomUUID(),
		entity_kind: input.entityKind,
		canonical_key: input.canonicalKey,
		suggestion_json: jsonText(input.payload),
		source_kind: "finance_mapping_candidates",
		source_ref_id: input.sourceRefId,
		confidence: input.confidence,
		status: "pending",
		applied_registry_id: null,
		created_at: input.createdAt,
		updated_at: input.createdAt,
	};
}

function isMaterialAmbiguous(
	suggestion: FinanceAccountMappingSuggestion,
	autoApplyThreshold: number,
) {
	return (
		suggestion.mapping.confidence >= 0.8 &&
		suggestion.mapping.confidence < autoApplyThreshold &&
		(suggestion.impact.rowCount >= 5 ||
			suggestion.impact.readyUnlockEstimate >= 3)
	);
}

async function reviewAmbiguousCluster(
	suggestion: FinanceAccountMappingSuggestion,
) {
	try {
		const prompt = readFileSync(
			resolve(PROMPTS_DIR, "finance-mapping-overseer-v1.md"),
			"utf8",
		);
		const result = await piJson({
			schema: overseerAdjustmentSchema,
			modelId: APP_CONFIG.fallbackModel,
			systemPrompt: prompt,
			userPrompt: JSON.stringify(
				{
					mapping: suggestion.mapping,
					impact: suggestion.impact,
					evidence: suggestion.evidence,
					dedupe: suggestion.dedupe,
				},
				null,
				2,
			),
		});
		return overseerAdjustmentSchema.parse(result.parsed);
	} catch {
		return {
			confidenceDelta: 0,
			reasons: ["overseer review unavailable"],
			requiresReview: true,
		};
	}
}

export async function generateFinanceMappingCandidates(
	input: GenerateFinanceMappingCandidatesInput = {},
) {
	const minConfidenceToPersist = input.minConfidenceToPersist ?? 0.8;
	const autoApplyThreshold = input.autoApplyThreshold ?? 0.95;
	const db = getDb();
	const [
		ledgerRows,
		reviewConfidence,
		existingSuggestionRows,
		existingMappingRows,
		overseerRows,
	] = await Promise.all([
		loadCandidateLedgerRows({ year: input.year ?? null }),
		loadReviewMappingConfidence(),
		db
			.selectFrom("registry_suggestions")
			.select(["entity_kind", "canonical_key", "status"])
			.where("entity_kind", "in", [
				"finance_account_mapping",
				"financial_account",
				"sender_rule",
			])
			.execute(),
		db.selectFrom("finance_account_mappings").select(["mapping_key"]).execute(),
		db
			.selectFrom("overseer_profiles")
			.select(["account_id", "profile_json"])
			.orderBy("created_at", "desc")
			.execute(),
	]);

	const existingSuggestionKeys = new Set(
		existingSuggestionRows
			.filter((row) => row.status === "pending" || row.status === "applied")
			.map((row) => `${row.entity_kind}:${row.canonical_key}`),
	);
	const existingMappingKeys = new Set(
		existingMappingRows.map((row) => row.mapping_key),
	);
	const overseerProfiles = mapProfileByAccount(overseerRows);
	const clusters = new Map<string, CandidateLedgerRow[]>();
	for (const row of ledgerRows) {
		const key = clusterKeyForRow(row);
		const current = clusters.get(key) ?? [];
		current.push(row);
		clusters.set(key, current);
	}

	const createdAt = nowIso();
	const sourceRefId = `mapping-candidates:${createdAt}`;
	const rowsToInsert: ReturnType<typeof suggestionRow>[] = [];
	let skippedLowConfidence = 0;
	let skippedDuplicates = 0;

	for (const [clusterKey, rows] of clusters) {
		const reviewMax = Math.max(
			0,
			...rows.map((row) => reviewConfidence.get(row.id) ?? 0),
		);
		const domains = senderDomains(rows);
		const accounts = evidenceAccounts(rows);
		const { confidence, reasons } = confidenceForCluster({
			rows,
			domains,
			accounts,
			reviewConfidence: reviewMax,
			overseerProfiles,
		});
		if (confidence < minConfidenceToPersist) {
			skippedLowConfidence += 1;
			continue;
		}
		const canonicalKey = `finance-mapping:${slug(clusterKey)}`;
		const mappingKey = mappingKeyForCluster(rows, clusterKey);
		const duplicateCanonicalKeys = [
			...(existingMappingKeys.has(mappingKey) ? [`mapping:${mappingKey}`] : []),
			...(existingSuggestionKeys.has(`finance_account_mapping:${canonicalKey}`)
				? [`suggestion:${canonicalKey}`]
				: []),
		];
		let suggestion = buildMappingSuggestion({
			clusterKey,
			rows,
			confidence,
			reasons,
			autoApplyThreshold,
			duplicateCanonicalKeys,
		});
		if (isMaterialAmbiguous(suggestion, autoApplyThreshold)) {
			const adjustment = await reviewAmbiguousCluster(suggestion);
			const adjustedConfidence = Math.max(
				0,
				Math.min(
					adjustment.requiresReview ? 0.94 : 1,
					Number(
						(
							suggestion.mapping.confidence + adjustment.confidenceDelta
						).toFixed(2),
					),
				),
			);
			suggestion = buildMappingSuggestion({
				clusterKey,
				rows,
				confidence: adjustedConfidence,
				reasons: [...reasons, ...adjustment.reasons],
				autoApplyThreshold,
				duplicateCanonicalKeys,
			});
		}
		if (
			existingMappingKeys.has(suggestion.mapping.mappingKey) ||
			existingSuggestionKeys.has(`finance_account_mapping:${canonicalKey}`)
		) {
			skippedDuplicates += 1;
			continue;
		}
		rowsToInsert.push(
			suggestionRow({
				entityKind: "finance_account_mapping",
				canonicalKey,
				payload: suggestion,
				sourceRefId,
				confidence: suggestion.mapping.confidence,
				createdAt,
			}),
		);
		existingSuggestionKeys.add(`finance_account_mapping:${canonicalKey}`);

		if (domains.length === 1 && suggestion.mapping.confidence >= 0.9) {
			const senderRuleKey = `mapping-candidate:sender-rule:${domains[0]}`;
			if (!existingSuggestionKeys.has(`sender_rule:${senderRuleKey}`)) {
				rowsToInsert.push(
					suggestionRow({
						entityKind: "sender_rule",
						canonicalKey: senderRuleKey,
						payload: {
							senderPattern: domains[0],
							domain: domains[0],
							priority: 50,
							notes: `Generated with ${suggestion.mapping.mappingKey}.`,
						},
						sourceRefId,
						confidence: suggestion.mapping.confidence,
						createdAt,
					}),
				);
				existingSuggestionKeys.add(`sender_rule:${senderRuleKey}`);
			}
		}

		const last4 = accounts
			.find((value) => value.startsWith("last4:"))
			?.slice("last4:".length);
		if (accounts.length > 0 && suggestion.mapping.confidence >= 0.9) {
			const accountName = accounts[0] ?? suggestion.mapping.mappingKey;
			const accountKey = `mapping-candidate:financial-account:${slug(accountName)}`;
			if (!existingSuggestionKeys.has(`financial_account:${accountKey}`)) {
				rowsToInsert.push(
					suggestionRow({
						entityKind: "financial_account",
						canonicalKey: accountKey,
						payload: {
							displayName: titlePart(accountName, "Financial Account"),
							aliases: uniqueStrings(accounts),
							accountLast4: last4 ?? null,
							currency: suggestion.mapping.currency,
							notes: `Generated with ${suggestion.mapping.mappingKey}.`,
						},
						sourceRefId,
						confidence: suggestion.mapping.confidence,
						createdAt,
					}),
				);
				existingSuggestionKeys.add(`financial_account:${accountKey}`);
			}
		}
	}

	if (rowsToInsert.length > 0) {
		await db.insertInto("registry_suggestions").values(rowsToInsert).execute();
		await queueJobIdempotent({
			kind: "reconcile_registry_suggestions",
			scopeType: "system",
			scopeId: "registry_suggestions",
		});
	}

	await publishActionEvent({
		topic: "finance",
		eventType: "finance.mapping_candidates_generated",
		entityKind: "registry_suggestion",
		entityId: sourceRefId,
		payload: {
			sourceRefId,
			candidates: rowsToInsert.filter(
				(row) => row.entity_kind === "finance_account_mapping",
			).length,
			suggestions: rowsToInsert.length,
			skippedLowConfidence,
			skippedDuplicates,
			changeHints: {
				islands: ["finance.mappings", "finance.readiness", "finance.lanes"],
			},
		},
	});

	return {
		sourceRefId,
		ledgerRows: ledgerRows.length,
		clusters: clusters.size,
		suggestions: rowsToInsert.length,
		mappingSuggestions: rowsToInsert.filter(
			(row) => row.entity_kind === "finance_account_mapping",
		).length,
		skippedLowConfidence,
		skippedDuplicates,
	};
}
