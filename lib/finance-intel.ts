import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadClassificationConfig } from "#/lib/category-rules";
import {
	APP_CONFIG,
	FINANCE_INTEL_PROMPT_VERSION,
	PROMPTS_DIR,
} from "#/lib/config";
import { piJson } from "#/lib/pi";
import type { RegistryMatchResult } from "#/lib/registry";
import type { FinanceIntelV2 } from "#/lib/schemas";
import {
	financeIntelJsonSchema,
	financeIntelV2Schema,
	normalizeFinanceIntel,
	normalizeMessageLabel,
} from "#/lib/schemas";
import { persistSecondaryResult } from "#/lib/secondary";

function readPrompt(name: string) {
	return readFileSync(resolve(PROMPTS_DIR, name), "utf8");
}

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
	const rootLabel = normalizeMessageLabel(input.rootLabel);
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
	const rootLabel = normalizeMessageLabel(input.rootLabel);
	if (!rootLabel) {
		throw new Error("Finance classifier requires a normalized root label");
	}
	const financeConfig = await loadClassificationConfig();
	const prompt = readPrompt("finance-intel-v2.md");
	const result = await piJson({
		schema: financeIntelV2Schema,
		modelId: APP_CONFIG.classifierModel,
		systemPrompt: prompt,
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
- Use null when a field cannot be supported by evidence.
- Keep messageKind and actionability conservative.
- Finance promotions or generic alerts should usually use actionability "none".`,
	});

	const parsed =
		normalizeFinanceIntel({
			...result.parsed,
			schemaVersion: financeIntelV2Schema.safeParse({
				...result.parsed,
				schemaVersion: "finance-intel.v2",
			}).success
				? "finance-intel.v2"
				: "finance-intel.v1",
		}) ??
		(() => {
			throw new Error("Finance classifier returned an invalid finance payload");
		})();
	const allowedIdentityIds = new Set(
		input.registryMatches.identities.map((identity) => identity.id),
	);
	const allowedInstitutionIds = new Set(
		input.registryMatches.institutions.map((institution) => institution.id),
	);
	const allowedFinancialAccountIds = new Set(
		input.registryMatches.financialAccounts.map((account) => account.id),
	);

	const financeIntel: FinanceIntelV2 = {
		...parsed,
		transactionCandidates: parsed.transactionCandidates.map((candidate) => ({
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
		})),
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
			identityHints: normalizeHints([
				...parsed.unresolvedEntityHints.identityHints,
				...(input.registryMatches.identities.length === 0 &&
				rootLabel.finance.owner !== "unknown"
					? [rootLabel.finance.owner]
					: []),
			]),
			institutionHints: normalizeHints(
				parsed.unresolvedEntityHints.institutionHints,
			),
			financialAccountHints: normalizeHints([
				...parsed.unresolvedEntityHints.financialAccountHints,
				...(input.registryMatches.financialAccounts.length === 0 &&
				rootLabel.finance.accountHint
					? [rootLabel.finance.accountHint]
					: []),
			]),
		},
	};

	const persisted = await persistSecondaryResult({
		jobId: input.jobId ?? null,
		messageId: input.messageId,
		classifierKey: "finance_intel",
		schemaVersion: "finance-intel.v2",
		model: result.modelId,
		backend: result.backend,
		promptVersion: FINANCE_INTEL_PROMPT_VERSION,
		source: "model",
		rawResponse: { assistantText: result.rawText },
		usage: result.usage,
		result: financeIntel,
		contentSha256: input.contentSha256,
		registrySha256: input.registryMatches.sha256,
		overallConfidence: financeIntel.confidence.overall,
	});

	const { projectMessageCategoryAssignment } = await import(
		"#/lib/category-rules"
	);
	await projectMessageCategoryAssignment(input.messageId);

	return {
		backend: result.backend,
		financeIntel,
		headStatus: persisted.status,
		lowConfidence: persisted.lowConfidence,
		model: result.modelId,
		usage: result.usage,
	};
}
