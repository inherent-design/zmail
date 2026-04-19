import { z } from "zod";
import { loadClassificationConfig } from "#/lib/category-rules";
import { APP_CONFIG, FINANCE_INTEL_PROMPT_VERSION } from "#/lib/config";
import { piJson } from "#/lib/pi";
import { readPromptIdentity } from "#/lib/prompt-identity";
import {
	persistEmailFinanceHintSuggestions,
	type RegistryMatchResult,
} from "#/lib/registry";
import type { FinanceIntelV3 } from "#/lib/schemas";
import {
	financeIntelJsonSchema,
	financeIntelV3Schema,
	parseCurrentMessageLabel,
} from "#/lib/schemas";
import { persistSecondaryResult } from "#/lib/secondary";

function sanitizeRef(
	value: string | null,
	allowedIds: Set<string>,
): string | null {
	if (!value) {
		return null;
	}
	return allowedIds.has(value) ? value : null;
}

function normalizeHints(values: string[]) {
	return Array.from(
		new Set(
			values.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	);
}

export type FinanceIntelModelContext = {
	messageId: string;
	rootSignal: string;
	rootBookHint: string;
	rootEvidence: string | null;
};

const MESSAGE_KIND_ALIASES: Record<string, FinanceIntelV3["messageKind"]> = {
	banking: "bank_alert",
	donation: "donation_receipt",
	investment: "investment_update",
	none: "other_finance",
	other: "other_finance",
	promotion: "finance_promotion",
	subscription: "subscription_billing",
	tax: "tax_document",
	transfer: "transfer_confirmation",
};

const MESSAGE_KINDS = new Set<FinanceIntelV3["messageKind"]>([
	"receipt",
	"invoice",
	"statement",
	"order_confirmation",
	"billing_notice",
	"subscription_billing",
	"bank_alert",
	"transfer_confirmation",
	"payroll",
	"tax_document",
	"tax_notice",
	"investment_update",
	"donation_receipt",
	"finance_promotion",
	"other_finance",
]);

const ACTIONABILITIES = new Set<FinanceIntelV3["actionability"]>([
	"none",
	"capture_document",
	"create_transaction_candidate",
	"update_registry_hint",
	"manual_review",
]);

const BOOK_SCOPES = new Set<FinanceIntelV3["book"]["scope"]>([
	"personal",
	"business",
	"mixed",
	"unknown",
]);

const LEDGER_STATUSES = new Set<FinanceIntelV3["ledgerReadiness"]["status"]>([
	"exportable",
	"review",
	"blocked",
	"not_ledger",
]);

const DIRECTIONS = new Set<
	FinanceIntelV3["transactionCandidates"][number]["direction"]
>(["expense", "income", "both", "neither", "unknown"]);

const CATEGORY_PRIMARY_VALUES = new Set<
	NonNullable<
		FinanceIntelV3["transactionCandidates"][number]["categoryPrimary"]
	>
>([
	"income",
	"housing",
	"utilities",
	"banking_fees",
	"transfers",
	"taxes",
	"insurance",
	"healthcare",
	"travel",
	"meals",
	"shopping",
	"software_services",
	"education",
	"office_business",
	"payroll_contractors",
	"investments",
	"donations",
	"subscriptions",
	"uncategorized",
]);

const REQUIRED_FIX_TOKENS = new Set([
	"amount",
	"date",
	"counterparty",
	"accountMapping",
	"dedupe",
	"bookScope",
	"businessUsePercent",
	"manualReview",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, max = 500): string | null {
	if (typeof value !== "string") {
		if (typeof value === "number" && Number.isFinite(value)) {
			return String(value);
		}
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.slice(0, max);
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function confidenceValue(value: unknown): number | null {
	const parsed = numberValue(value);
	if (parsed === null) {
		return null;
	}
	return Math.max(0, Math.min(1, parsed));
}

function arrayOfStrings(value: unknown, maxItems = 50, maxLength = 240) {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => stringValue(item, maxLength))
		.filter((item): item is string => item !== null)
		.slice(0, maxItems);
}

function recordAt(value: unknown, key: string): Record<string, unknown> {
	if (!isRecord(value)) {
		return {};
	}
	const nested = value[key];
	return isRecord(nested) ? nested : {};
}

function normalizeMessageKind(
	value: unknown,
	rootSignal?: string,
): FinanceIntelV3["messageKind"] {
	const raw = stringValue(value, 80);
	if (raw) {
		if (MESSAGE_KINDS.has(raw as FinanceIntelV3["messageKind"])) {
			return raw as FinanceIntelV3["messageKind"];
		}
		const alias = MESSAGE_KIND_ALIASES[raw];
		if (alias) {
			return alias;
		}
	}
	const rootAlias = rootSignal ? MESSAGE_KIND_ALIASES[rootSignal] : null;
	if (rootAlias) {
		return rootAlias;
	}
	if (
		rootSignal &&
		MESSAGE_KINDS.has(rootSignal as FinanceIntelV3["messageKind"])
	) {
		return rootSignal as FinanceIntelV3["messageKind"];
	}
	return "other_finance";
}

function normalizeBookScope(
	value: unknown,
	fallback: string,
): FinanceIntelV3["book"]["scope"] {
	const raw = stringValue(value, 40) ?? fallback;
	return BOOK_SCOPES.has(raw as FinanceIntelV3["book"]["scope"])
		? (raw as FinanceIntelV3["book"]["scope"])
		: "unknown";
}

function normalizeDirection(
	value: unknown,
): FinanceIntelV3["transactionCandidates"][number]["direction"] {
	const raw = stringValue(value, 40);
	if (!raw) {
		return "unknown";
	}
	if (
		DIRECTIONS.has(
			raw as FinanceIntelV3["transactionCandidates"][number]["direction"],
		)
	) {
		return raw as FinanceIntelV3["transactionCandidates"][number]["direction"];
	}
	if (["debit", "charge", "purchase"].includes(raw)) {
		return "expense";
	}
	if (["credit", "deposit"].includes(raw)) {
		return "income";
	}
	return "unknown";
}

function normalizeCategoryPrimary(value: unknown) {
	const raw = stringValue(value, 120);
	if (!raw) {
		return null;
	}
	return CATEGORY_PRIMARY_VALUES.has(
		raw as NonNullable<
			FinanceIntelV3["transactionCandidates"][number]["categoryPrimary"]
		>,
	)
		? raw
		: "uncategorized";
}

function normalizeFieldConfidence(value: unknown) {
	const record = isRecord(value) ? value : {};
	return {
		amount: confidenceValue(record.amount),
		date: confidenceValue(record.date),
		counterparty: confidenceValue(record.counterparty),
		accountMapping: confidenceValue(record.accountMapping),
		book: confidenceValue(record.book),
		category: confidenceValue(record.category),
		dedupe: confidenceValue(record.dedupe),
	};
}

function normalizeRequiredFixes(value: unknown) {
	const raw = arrayOfStrings(value, 12, 240);
	return raw.map((item) => {
		if (REQUIRED_FIX_TOKENS.has(item)) {
			return item;
		}
		const lower = item.toLowerCase();
		if (lower.includes("amount")) {
			return "amount";
		}
		if (lower.includes("date") || lower.includes("occurred")) {
			return "date";
		}
		if (lower.includes("counterparty") || lower.includes("merchant")) {
			return "counterparty";
		}
		if (lower.includes("account")) {
			return "accountMapping";
		}
		if (lower.includes("dedupe") || lower.includes("duplicate")) {
			return "dedupe";
		}
		if (lower.includes("book")) {
			return "bookScope";
		}
		if (lower.includes("business") || lower.includes("allocation")) {
			return "businessUsePercent";
		}
		return "manualReview";
	});
}

function normalizeBeancount(value: unknown) {
	const record = isRecord(value) ? value : {};
	return {
		debitAccount: stringValue(record.debitAccount, 240),
		creditAccount: stringValue(record.creditAccount, 240),
		currency: stringValue(record.currency, 16),
		mappingKey: stringValue(record.mappingKey, 240),
		confidence: confidenceValue(record.confidence) ?? 0,
		metadata: isRecord(record.metadata) ? record.metadata : {},
	};
}

function normalizeTransactionDedupe(value: unknown) {
	const record = isRecord(value) ? value : {};
	return {
		externalTransactionId: stringValue(record.externalTransactionId, 240),
		statementRowId: stringValue(record.statementRowId, 240),
		normalizedComposite: stringValue(record.normalizedComposite, 500),
		emailEvidenceKey: stringValue(record.emailEvidenceKey, 500),
	};
}

function normalizeTransactionCandidate(
	value: unknown,
	context: FinanceIntelModelContext,
	topLevelBook: FinanceIntelV3["book"]["scope"],
) {
	const record = isRecord(value) ? value : {};
	const amountObject = isRecord(record.amount) ? record.amount : {};
	const categoryObject = isRecord(record.category) ? record.category : {};
	const amount =
		stringValue(record.amount, 64) ??
		stringValue(amountObject.value, 64) ??
		stringValue(amountObject.amount, 64);
	const occurredAt =
		stringValue(record.occurredAt, 64) ??
		stringValue(record.transactionDate, 64) ??
		stringValue(record.date, 64);
	const merchantOrCounterparty =
		stringValue(record.merchantOrCounterparty, 240) ??
		stringValue(record.counterparty, 240) ??
		stringValue(record.merchant, 240);
	let book = normalizeBookScope(record.book, topLevelBook);
	const businessUsePercent = numberValue(record.businessUsePercent);
	let normalizedCritical = false;
	if (book === "mixed" && businessUsePercent === null) {
		book = "unknown";
		normalizedCritical = true;
	}
	if (!amount || !occurredAt || !merchantOrCounterparty) {
		normalizedCritical = true;
	}
	const beancount = normalizeBeancount(record.beancount);
	if (normalizedCritical) {
		beancount.debitAccount = null;
		beancount.creditAccount = null;
		beancount.mappingKey = null;
		beancount.confidence = 0;
	}
	return {
		value: {
			kind:
				stringValue(record.kind, 80) ??
				normalizeMessageKind(record.messageKind, context.rootSignal),
			direction: normalizeDirection(record.direction),
			amount,
			currency:
				stringValue(record.currency, 16) ??
				stringValue(amountObject.currency, 16),
			occurredAt,
			merchantOrCounterparty,
			ownerIdentityRef: stringValue(record.ownerIdentityRef, 120),
			financialAccountRef: stringValue(record.financialAccountRef, 120),
			institutionRef: stringValue(record.institutionRef, 120),
			categoryPrimary:
				normalizeCategoryPrimary(record.categoryPrimary) ??
				normalizeCategoryPrimary(categoryObject.primary),
			categorySecondary:
				stringValue(record.categorySecondary, 120) ??
				stringValue(categoryObject.secondary, 120),
			statementRefHint: stringValue(record.statementRefHint, 160),
			taxRelevanceHint: stringValue(record.taxRelevanceHint, 240),
			evidence:
				stringValue(record.evidence, 500) ??
				"Model did not provide field-level evidence.",
			externalTransactionId: stringValue(record.externalTransactionId, 240),
			postedAt: stringValue(record.postedAt, 64),
			clearedAt: stringValue(record.clearedAt, 64),
			book,
			businessUsePercent,
			fieldConfidence: normalizeFieldConfidence(record.fieldConfidence),
			dedupe: normalizeTransactionDedupe(record.dedupe),
			beancount,
		},
		normalizedCritical,
	};
}

function normalizeDocumentCandidate(
	value: unknown,
	topLevelBook: FinanceIntelV3["book"]["scope"],
) {
	const record = isRecord(value) ? value : {};
	return {
		documentType: stringValue(record.documentType, 80) ?? "finance_document",
		issuer: stringValue(record.issuer, 240),
		externalId: stringValue(record.externalId, 160),
		statementPeriodStart: stringValue(record.statementPeriodStart, 64),
		statementPeriodEnd: stringValue(record.statementPeriodEnd, 64),
		dueAt: stringValue(record.dueAt, 64),
		taxYear: numberValue(record.taxYear),
		attachmentRefs: arrayOfStrings(record.attachmentRefs, 20, 240),
		evidence:
			stringValue(record.evidence, 500) ??
			"Model did not provide document evidence.",
		accountRefHint: stringValue(record.accountRefHint, 160),
		institutionRefHint: stringValue(record.institutionRefHint, 160),
		sourceDocumentRefs: arrayOfStrings(record.sourceDocumentRefs, 20, 240),
		statementOpeningBalance: stringValue(record.statementOpeningBalance, 64),
		statementClosingBalance: stringValue(record.statementClosingBalance, 64),
		statementTransactionCount: numberValue(record.statementTransactionCount),
		statementCurrency: stringValue(record.statementCurrency, 16),
		book: normalizeBookScope(record.book, topLevelBook),
		fieldConfidence: normalizeFieldConfidence(record.fieldConfidence),
	};
}

export function buildBlockedFinanceIntelV3(input: {
	messageId: string;
	rootSignal: string;
	rootBookHint: string;
	rootEvidence: string | null;
}): FinanceIntelV3 {
	return {
		schemaVersion: "finance-intel.v3",
		messageKind: normalizeMessageKind(null, input.rootSignal),
		actionability: "manual_review",
		book: {
			scope: normalizeBookScope(null, input.rootBookHint),
			businessUsePercent: null,
			taxTreatmentHint: null,
			evidence: input.rootEvidence,
		},
		ledgerReadiness: {
			status: "blocked",
			reasons: ["model_output_invalid"],
			requiredFixes: ["manualReview"],
		},
		transactionCandidates: [],
		documentCandidates: [],
		matchedRegistryRefs: {
			identityIds: [],
			institutionIds: [],
			financialAccountIds: [],
		},
		unresolvedEntityHints: {
			identityHints: [],
			institutionHints: [],
			financialAccountHints: [],
		},
		dedupe: {
			messageEvidenceKey: `email:${input.messageId}`,
			sourceDocumentRefs: [],
			externalTransactionIds: [],
			normalizedComposites: [],
		},
		fieldConfidence: {
			amount: null,
			date: null,
			counterparty: null,
			accountMapping: null,
			book: null,
			category: null,
			dedupe: null,
		},
		confidence: {
			overall: 0,
			messageKind: 0,
			transactionExtraction: 0,
			registryMatching: 0,
		},
		explanation:
			"Blocked because model output did not satisfy finance-intel.v3.",
	};
}

function isRecoverableModelOutputError(error: unknown) {
	if (error instanceof SyntaxError) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("Unexpected token") ||
		message.includes("Unexpected end of JSON") ||
		message.includes("JSON") ||
		message.includes("Empty assistant response")
	);
}

export function normalizeFinanceIntelV3ModelOutput(
	raw: unknown,
	context: FinanceIntelModelContext,
) {
	const record = isRecord(raw) ? raw : {};
	const messageKind = normalizeMessageKind(
		record.messageKind,
		context.rootSignal,
	);
	const rawBook = recordAt(record, "book");
	const book = {
		scope: normalizeBookScope(rawBook.scope, context.rootBookHint),
		businessUsePercent: numberValue(rawBook.businessUsePercent),
		taxTreatmentHint: stringValue(rawBook.taxTreatmentHint, 240),
		evidence: stringValue(rawBook.evidence, 500) ?? context.rootEvidence,
	};
	if (book.scope === "mixed" && book.businessUsePercent === null) {
		book.scope = "unknown";
	}
	const rawLedgerReadiness = recordAt(record, "ledgerReadiness");
	const normalizedTransactions = (
		Array.isArray(record.transactionCandidates)
			? record.transactionCandidates
			: []
	).map((candidate) =>
		normalizeTransactionCandidate(candidate, context, book.scope),
	);
	const normalizedCritical = normalizedTransactions.some(
		(candidate) => candidate.normalizedCritical,
	);
	const actionability = ACTIONABILITIES.has(
		record.actionability as FinanceIntelV3["actionability"],
	)
		? (record.actionability as FinanceIntelV3["actionability"])
		: "manual_review";
	let ledgerStatus = LEDGER_STATUSES.has(
		rawLedgerReadiness.status as FinanceIntelV3["ledgerReadiness"]["status"],
	)
		? (rawLedgerReadiness.status as FinanceIntelV3["ledgerReadiness"]["status"])
		: actionability === "none"
			? "not_ledger"
			: "review";
	if (normalizedCritical && ledgerStatus === "exportable") {
		ledgerStatus = "review";
	}
	const requiredFixes = normalizeRequiredFixes(
		rawLedgerReadiness.requiredFixes,
	);
	if (normalizedCritical && requiredFixes.length === 0) {
		requiredFixes.push("manualReview");
	}
	const rawMatchedRegistryRefs = recordAt(record, "matchedRegistryRefs");
	const rawUnresolvedEntityHints = recordAt(record, "unresolvedEntityHints");
	const rawDedupe = recordAt(record, "dedupe");
	const rawConfidence = recordAt(record, "confidence");
	return {
		schemaVersion: "finance-intel.v3",
		messageKind,
		actionability,
		book,
		ledgerReadiness: {
			status: ledgerStatus,
			reasons: arrayOfStrings(rawLedgerReadiness.reasons, 12, 160),
			requiredFixes,
		},
		transactionCandidates: normalizedTransactions.map(
			(candidate) => candidate.value,
		),
		documentCandidates: (Array.isArray(record.documentCandidates)
			? record.documentCandidates
			: []
		).map((candidate) => normalizeDocumentCandidate(candidate, book.scope)),
		matchedRegistryRefs: {
			identityIds: arrayOfStrings(rawMatchedRegistryRefs.identityIds),
			institutionIds: arrayOfStrings(rawMatchedRegistryRefs.institutionIds),
			financialAccountIds: arrayOfStrings(
				rawMatchedRegistryRefs.financialAccountIds,
			),
		},
		unresolvedEntityHints: {
			identityHints: arrayOfStrings(rawUnresolvedEntityHints.identityHints),
			institutionHints: arrayOfStrings(
				rawUnresolvedEntityHints.institutionHints,
			),
			financialAccountHints: arrayOfStrings(
				rawUnresolvedEntityHints.financialAccountHints,
			),
		},
		dedupe: {
			messageEvidenceKey: stringValue(rawDedupe.messageEvidenceKey, 500),
			sourceDocumentRefs: arrayOfStrings(rawDedupe.sourceDocumentRefs, 20, 240),
			externalTransactionIds: arrayOfStrings(
				rawDedupe.externalTransactionIds,
				50,
				240,
			),
			normalizedComposites: arrayOfStrings(
				rawDedupe.normalizedComposites,
				50,
				500,
			),
		},
		fieldConfidence: normalizeFieldConfidence(record.fieldConfidence),
		confidence: {
			overall: confidenceValue(rawConfidence.overall) ?? 0,
			messageKind: confidenceValue(rawConfidence.messageKind) ?? 0,
			transactionExtraction:
				confidenceValue(rawConfidence.transactionExtraction) ?? 0,
			registryMatching: confidenceValue(rawConfidence.registryMatching) ?? 0,
		},
		explanation:
			stringValue(record.explanation, 500) ??
			"Finance intel normalized from model output.",
	};
}

function buildRegistryPromptContext(matches: RegistryMatchResult) {
	return {
		identities: matches.identities.map((identity) => ({
			id: identity.id,
			kind: identity.kind,
			displayName: identity.displayName,
			aliases: identity.aliases,
			emailAddresses: identity.emailAddresses,
			domains: identity.domains,
			taxOwnerHint: identity.taxOwnerHint,
		})),
		institutions: matches.institutions.map((institution) => ({
			id: institution.id,
			displayName: institution.displayName,
			aliases: institution.aliases,
			domains: institution.domains,
		})),
		financialAccounts: matches.financialAccounts.map((account) => ({
			id: account.id,
			institutionId: account.institutionId,
			ownerIdentityId: account.ownerIdentityId,
			displayName: account.displayName,
			aliases: account.aliases,
			accountMask: account.accountMask,
			accountLast4: account.accountLast4,
			accountType: account.accountType,
			currency: account.currency,
			taxOwnerHint: account.taxOwnerHint,
		})),
		senderRules: matches.senderRules.map((rule) => ({
			id: rule.id,
			senderPattern: rule.senderPattern,
			domain: rule.domain,
			ownerIdentityId: rule.ownerIdentityId,
			institutionId: rule.institutionId,
			financialAccountId: rule.financialAccountId,
			messageKindHint: rule.messageKindHint,
			priority: rule.priority,
		})),
		accountMappings: (matches.accountMappings ?? [])
			.slice(0, 20)
			.map((mapping) => ({
				mappingKey: mapping.mappingKey,
				book: mapping.book,
				debitAccount: mapping.debitAccount,
				creditAccount: mapping.creditAccount,
				currency: mapping.currency,
				confidence: mapping.confidence,
				notes: mapping.notes,
			})),
	};
}

export function buildFinanceIntelPrompt(input: {
	accountLabel: string;
	accountEmail: string;
	sender: string;
	subject: string;
	receivedAt: string;
	bodyText: string;
	attachmentsSummary: string;
	rootLabel: unknown;
	registryMatches: RegistryMatchResult;
	financeTaxonomy?: Awaited<
		ReturnType<typeof loadClassificationConfig>
	>["financeTaxonomy"];
}) {
	const rootLabel = parseCurrentMessageLabel(input.rootLabel);
	return [
		`Account: ${input.accountLabel}`,
		`Account email: ${input.accountEmail}`,
		`Sender: ${input.sender}`,
		`Subject: ${input.subject}`,
		`Received: ${input.receivedAt}`,
		`Attachments: ${input.attachmentsSummary}`,
		"",
		"Allowed finance taxonomy:",
		JSON.stringify(
			input.financeTaxonomy ?? {
				schemaVersion: "finance-taxonomy.v1",
				categories: [],
			},
			null,
			2,
		),
		"",
		"Current root label:",
		JSON.stringify(rootLabel, null, 2),
		"",
		"Matched operator registry context:",
		JSON.stringify(buildRegistryPromptContext(input.registryMatches), null, 2),
		"",
		"Normalized body:",
		input.bodyText,
	].join("\n");
}

export async function classifyFinanceMessageNow(input: {
	jobId?: string | null;
	messageId: string;
	accountLabel: string;
	accountEmail: string;
	sender: string;
	subject: string;
	receivedAt: string;
	bodyText: string;
	attachmentsSummary: string;
	rootLabel: unknown;
	registryMatches: RegistryMatchResult;
	contentSha256: string | null;
}) {
	const rootLabel = parseCurrentMessageLabel(input.rootLabel);
	if (!rootLabel) {
		throw new Error(
			"Finance classifier requires a message-label.v3 root label",
		);
	}
	const financeConfig = await loadClassificationConfig();
	const prompt = readPromptIdentity("finance-intel-v3.md");
	const modelContext: FinanceIntelModelContext = {
		messageId: input.messageId,
		rootSignal: rootLabel.finance.signal,
		rootBookHint: rootLabel.finance.bookHint,
		rootEvidence: rootLabel.finance.evidence,
	};
	let result: Awaited<ReturnType<typeof piJson<unknown>>> | null = null;
	let parsed: FinanceIntelV3;
	let blockedModelOutput = false;
	let rawResponse: unknown;
	try {
		result = await piJson({
			schema: z.unknown(),
			modelId: APP_CONFIG.classifierModel,
			systemPrompt: prompt.text,
			userPrompt: `${buildFinanceIntelPrompt({
				...input,
				rootLabel,
				financeTaxonomy: financeConfig.financeTaxonomy,
			})}

JSON contract:
${JSON.stringify(financeIntelJsonSchema, null, 2)}

Return one JSON object only.
- Do not use markdown fences.
- Use matched registry ids only when they are explicitly present in the matched registry context.
- Use only accountMappings[].mappingKey values listed in the matched registry context. Do not invent Beancount accounts or mapping keys.
- Use null when a field cannot be supported by evidence.
- Keep messageKind and actionability conservative.
- Finance promotions or generic alerts should usually use actionability "none".`,
		});
		const normalized = normalizeFinanceIntelV3ModelOutput(
			result.parsed,
			modelContext,
		);
		const parsedResult = financeIntelV3Schema.safeParse(normalized);
		if (parsedResult.success) {
			parsed = parsedResult.data;
			rawResponse = { assistantText: result.rawText };
		} else {
			blockedModelOutput = true;
			parsed = buildBlockedFinanceIntelV3(modelContext);
			rawResponse = {
				assistantText: result.rawText,
				normalized,
				parseError: parsedResult.error.message,
			};
		}
	} catch (error) {
		if (!isRecoverableModelOutputError(error)) {
			throw error;
		}
		blockedModelOutput = true;
		parsed = buildBlockedFinanceIntelV3(modelContext);
		rawResponse = {
			assistantText: null,
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
	const allowedIdentityIds = new Set(
		input.registryMatches.identities.map((identity) => identity.id),
	);
	const allowedInstitutionIds = new Set(
		input.registryMatches.institutions.map((institution) => institution.id),
	);
	const allowedFinancialAccountIds = new Set(
		input.registryMatches.financialAccounts.map((account) => account.id),
	);
	const accountMappingsByKey = new Map(
		(input.registryMatches.accountMappings ?? []).map((mapping) => [
			mapping.mappingKey,
			mapping,
		]),
	);

	const transactionCandidates = parsed.transactionCandidates.map(
		(candidate) => {
			const mappingKey = candidate.beancount.mappingKey;
			const mapping = mappingKey ? accountMappingsByKey.get(mappingKey) : null;
			const beancount = { ...candidate.beancount };
			if (!mapping) {
				beancount.mappingKey = null;
				beancount.debitAccount = null;
				beancount.creditAccount = null;
				beancount.currency = null;
				beancount.confidence = 0;
			} else {
				beancount.mappingKey = mapping.mappingKey;
				beancount.debitAccount = mapping.debitAccount;
				beancount.creditAccount = mapping.creditAccount;
				beancount.currency = mapping.currency ?? candidate.currency;
				beancount.confidence = Math.max(
					beancount.confidence,
					mapping.confidence,
				);
			}
			return {
				...candidate,
				ownerIdentityRef: sanitizeRef(
					candidate.ownerIdentityRef,
					allowedIdentityIds,
				),
				institutionRef: sanitizeRef(
					candidate.institutionRef,
					allowedInstitutionIds,
				),
				financialAccountRef: sanitizeRef(
					candidate.financialAccountRef,
					allowedFinancialAccountIds,
				),
				beancount,
			};
		},
	);
	const missingMapping = transactionCandidates.some(
		(candidate) => !candidate.beancount.mappingKey,
	);
	const ledgerReadiness =
		parsed.ledgerReadiness.status === "exportable" && missingMapping
			? {
					status: "review" as const,
					reasons: Array.from(
						new Set([
							...parsed.ledgerReadiness.reasons,
							"missing_account_mapping",
						]),
					),
					requiredFixes: Array.from(
						new Set([
							...parsed.ledgerReadiness.requiredFixes,
							"accountMapping",
						]),
					),
				}
			: parsed.ledgerReadiness;

	const financeIntel: FinanceIntelV3 = {
		...parsed,
		ledgerReadiness,
		transactionCandidates,
		matchedRegistryRefs: {
			identityIds: input.registryMatches.identities.map(
				(identity) => identity.id,
			),
			institutionIds: input.registryMatches.institutions.map(
				(institution) => institution.id,
			),
			financialAccountIds: input.registryMatches.financialAccounts.map(
				(account) => account.id,
			),
		},
		unresolvedEntityHints: {
			identityHints: normalizeHints(parsed.unresolvedEntityHints.identityHints),
			institutionHints: normalizeHints(
				parsed.unresolvedEntityHints.institutionHints,
			),
			financialAccountHints: normalizeHints(
				parsed.unresolvedEntityHints.financialAccountHints,
			),
		},
	};

	const persisted = await persistSecondaryResult({
		jobId: input.jobId ?? null,
		messageId: input.messageId,
		classifierKey: "finance_intel",
		schemaVersion: "finance-intel.v3",
		model: result?.modelId ?? APP_CONFIG.classifierModel,
		backend: result?.backend ?? "model_parse_error",
		promptVersion: FINANCE_INTEL_PROMPT_VERSION,
		promptSha256: prompt.sha256,
		source: "model",
		rawResponse,
		usage: result?.usage ?? null,
		result: financeIntel,
		contentSha256: input.contentSha256,
		registrySha256: input.registryMatches.sha256,
		overallConfidence: financeIntel.confidence.overall,
		status: blockedModelOutput ? "review" : undefined,
	});
	await persistEmailFinanceHintSuggestions({
		secondaryResultId: persisted.resultId,
		messageId: input.messageId,
		financeIntel,
	});

	const { projectMessageCategoryAssignment } = await import(
		"#/lib/category-rules"
	);
	await projectMessageCategoryAssignment(input.messageId);

	return {
		backend: result?.backend ?? "model_parse_error",
		financeIntel,
		headStatus: persisted.status,
		lowConfidence: persisted.lowConfidence,
		model: result?.modelId ?? APP_CONFIG.classifierModel,
		blockedModelOutput,
		usage: result?.usage ?? null,
	};
}
