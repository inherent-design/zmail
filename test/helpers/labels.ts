import {
	type FinanceIntelV1,
	type FinanceIntelV2,
	financeIntelV1Schema,
	financeIntelV2Schema,
	type MessageLabelV1,
	type MessageLabelV2,
	messageLabelV1Schema,
	messageLabelV2Schema,
} from "#/lib/schemas";

type Primitive = string | number | boolean | null | undefined;
type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends Primitive
		? T[K]
		: T[K] extends Array<infer U>
			? Array<DeepPartial<U>>
			: DeepPartial<T[K]>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeUnknown(base: unknown, override: unknown): unknown {
	if (!override) {
		return structuredClone(base);
	}
	if (Array.isArray(base) || Array.isArray(override)) {
		return structuredClone(override ?? base);
	}
	if (!isPlainObject(base) || !isPlainObject(override)) {
		return structuredClone(override ?? base);
	}

	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) {
			continue;
		}
		const current = result[key];
		result[key] =
			isPlainObject(current) && isPlainObject(value)
				? mergeUnknown(current, value)
				: structuredClone(value);
	}
	return result;
}

function mergeDeep<T>(base: T, override?: DeepPartial<T>): T {
	return mergeUnknown(base, override) as T;
}

export function buildMessageLabelV2(
	overrides?: DeepPartial<MessageLabelV2>,
): MessageLabelV2 {
	return messageLabelV2Schema.parse(
		mergeDeep(
			{
				schemaVersion: "message-label.v2",
				nsfw: false,
				finance: {
					relevant: false,
					direction: "neither",
					owner: "unknown",
					accountHint: null,
					purpose: null,
				},
				people: {
					personal: false,
					private: false,
					networking: false,
					community: false,
					recruiting: false,
					business: false,
				},
				commerce: {
					transactional: false,
					shopping: false,
					subscription: false,
					travel: false,
					legal: false,
				},
				knowledge: {
					course: false,
					resource: false,
					documentation: false,
					newsletter: false,
					research: false,
				},
				assets: {
					license: false,
					credential: false,
					account: false,
					document: false,
				},
				entertainment: {
					gaming: false,
					media: false,
					fandom: false,
				},
				risk: {
					businessSensitive: false,
					leakRisk: false,
				},
				routing: {
					primaryBucket: "other",
					secondaryBuckets: [],
					tags: [],
				},
				confidence: {
					overall: 1,
					finance: 1,
					people: 1,
					commerce: 1,
					knowledge: 1,
					assets: 1,
					entertainment: 1,
					risk: 1,
				},
				explanation: "Test v2 label.",
			} satisfies MessageLabelV2,
			overrides,
		),
	);
}

export function buildManualOverrideLabelV2(
	overrides?: DeepPartial<MessageLabelV2>,
): MessageLabelV2 {
	return buildMessageLabelV2(
		mergeDeep(
			{
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "amex",
					purpose: "client lunch",
				},
				people: {
					personal: false,
					private: false,
					networking: false,
					community: false,
					recruiting: false,
					business: true,
				},
				commerce: {
					transactional: true,
					shopping: false,
					subscription: false,
					travel: false,
					legal: false,
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt", "shopping"],
					tags: ["receipt", "meals"],
				},
				explanation: "Manual override for review coverage.",
			} as DeepPartial<MessageLabelV2>,
			overrides,
		),
	);
}

export function buildLegacyMessageLabelV1(
	overrides?: DeepPartial<MessageLabelV1>,
): MessageLabelV1 {
	return messageLabelV1Schema.parse(
		mergeDeep(
			{
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: false,
					direction: "unknown",
					owner: "unknown",
					accountHint: null,
					purpose: null,
				},
				social: {
					personal: false,
					private: false,
					social: false,
					business: false,
				},
				risk: {
					businessSensitive: false,
					leakRisk: false,
				},
				routing: {
					primaryBucket: "other",
					tags: [],
				},
				confidence: {
					overall: 1,
					finance: 1,
					social: 1,
					risk: 1,
				},
				explanation: "Test legacy label.",
			} satisfies MessageLabelV1,
			overrides,
		),
	);
}

export function buildFinanceIntelV2(
	overrides?: DeepPartial<FinanceIntelV2>,
): FinanceIntelV2 {
	return financeIntelV2Schema.parse(
		mergeDeep(
			{
				schemaVersion: "finance-intel.v2",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-01",
						merchantOrCounterparty: "billing@example.com",
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryPrimary: "shopping",
						categorySecondary: "retail",
						statementRefHint: null,
						taxRelevanceHint: "business expense",
						evidence: "Test finance evidence.",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "billing@example.com",
						externalId: null,
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						accountRefHint: null,
						institutionRefHint: null,
						attachmentRefs: [],
						evidence: "Test receipt evidence.",
					},
				],
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
				confidence: {
					overall: 1,
					messageKind: 1,
					transactionExtraction: 1,
					registryMatching: 1,
				},
				explanation: "Test finance intel v2 payload.",
			} satisfies FinanceIntelV2,
			overrides,
		),
	);
}

export function buildLegacyFinanceIntelV1(
	overrides?: DeepPartial<FinanceIntelV1>,
): FinanceIntelV1 {
	return financeIntelV1Schema.parse(
		mergeDeep(
			{
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-01",
						merchantOrCounterparty: "billing@example.com",
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Legacy finance evidence.",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "billing@example.com",
						externalId: null,
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: [],
						evidence: "Legacy receipt evidence.",
					},
				],
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
				confidence: {
					overall: 1,
					messageKind: 1,
					transactionExtraction: 1,
					registryMatching: 1,
				},
				explanation: "Legacy finance intel payload.",
			} satisfies FinanceIntelV1,
			overrides,
		),
	);
}
