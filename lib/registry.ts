import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse, stringify } from "yaml";

import { APP_CONFIG, nowIso } from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import { publishActionEvent } from "#/lib/runtime-events";
import {
	type FinanceAccountMapping,
	type FinanceIntelV3,
	financeAccountMappingFileSchema,
	financeAccountMappingSchema,
	parseCurrentMessageLabel,
	type RegistryFinancialAccount,
	type RegistryIdentity,
	type RegistryInstitution,
	type RegistrySenderRule,
	registryFinancialAccountFileSchema,
	registryIdentityFileSchema,
	registryInstitutionFileSchema,
	registrySenderRuleFileSchema,
} from "#/lib/schemas";

const REGISTRY_STATE_KEY = "operator_registry";

export interface OperatorRegistrySnapshot {
	sha256: string;
	importedAt: string | null;
	sourceDir: string;
	identities: RegistryIdentity[];
	institutions: RegistryInstitution[];
	financialAccounts: RegistryFinancialAccount[];
	senderRules: RegistrySenderRule[];
	accountMappings: FinanceAccountMapping[];
}

export interface RegistryMatchResult {
	sha256: string;
	identities: RegistryIdentity[];
	institutions: RegistryInstitution[];
	financialAccounts: RegistryFinancialAccount[];
	senderRules: RegistrySenderRule[];
	accountMappings: FinanceAccountMapping[];
}

function normalizeUnique(values: string[]) {
	return Array.from(
		new Set(
			values.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	).sort((left, right) => left.localeCompare(right));
}

function sortById<T extends { id: string }>(rows: T[]) {
	return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function sortByMappingKey<T extends { mappingKey: string }>(rows: T[]) {
	return [...rows].sort((left, right) =>
		left.mappingKey.localeCompare(right.mappingKey),
	);
}

function normalizeRegistryIdentity(
	identity: RegistryIdentity,
): RegistryIdentity {
	return {
		...identity,
		aliases: normalizeUnique(identity.aliases),
		emailAddresses: normalizeUnique(
			identity.emailAddresses.map((value) => value.toLowerCase()),
		),
		domains: normalizeUnique(
			identity.domains.map((value) => value.toLowerCase()),
		),
	};
}

function normalizeRegistryInstitution(
	institution: RegistryInstitution,
): RegistryInstitution {
	return {
		...institution,
		aliases: normalizeUnique(institution.aliases),
		domains: normalizeUnique(
			institution.domains.map((value) => value.toLowerCase()),
		),
	};
}

function normalizeRegistryFinancialAccount(
	account: RegistryFinancialAccount,
): RegistryFinancialAccount {
	return {
		...account,
		aliases: normalizeUnique(account.aliases),
		accountLast4: account.accountLast4 ? account.accountLast4.trim() : null,
	};
}

function normalizeRegistrySenderRule(
	rule: RegistrySenderRule,
): RegistrySenderRule {
	return {
		...rule,
		senderPattern: rule.senderPattern.trim().toLowerCase(),
		domain: rule.domain ? rule.domain.trim().toLowerCase() : null,
	};
}

function normalizeFinanceAccountMapping(
	mapping: FinanceAccountMapping,
): FinanceAccountMapping {
	return {
		...mapping,
		mappingKey: mapping.mappingKey.trim(),
		debitAccount: mapping.debitAccount?.trim() || null,
		creditAccount: mapping.creditAccount?.trim() || null,
		currency: mapping.currency?.trim() || null,
		notes: mapping.notes?.trim() || null,
	};
}

function buildEmptyRegistry(
	baseDir = APP_CONFIG.registryDir,
): OperatorRegistrySnapshot {
	const identities: RegistryIdentity[] = [];
	const institutions: RegistryInstitution[] = [];
	const financialAccounts: RegistryFinancialAccount[] = [];
	const senderRules: RegistrySenderRule[] = [];
	const accountMappings: FinanceAccountMapping[] = [];
	return {
		sha256: buildRegistrySha256({
			identities,
			institutions,
			financialAccounts,
			senderRules,
			accountMappings,
		}),
		importedAt: null,
		sourceDir: baseDir,
		identities,
		institutions,
		financialAccounts,
		senderRules,
		accountMappings,
	};
}

function loadYamlFile<T>(
	path: string,
	parseFile: (input: unknown) => T,
	fallback: T,
) {
	if (!existsSync(path)) {
		return fallback;
	}
	const raw = readFileSync(path, "utf8").trim();
	if (!raw) {
		return fallback;
	}
	return parseFile(parse(raw));
}

function writeYamlIfMissing(path: string, value: unknown) {
	if (existsSync(path)) {
		return;
	}
	writeFileSync(path, `${stringify(value).trimEnd()}\n`, "utf8");
}

export function getRegistryPaths(baseDir = APP_CONFIG.registryDir) {
	return {
		identities: resolve(baseDir, "identities.yaml"),
		institutions: resolve(baseDir, "institutions.yaml"),
		financialAccounts: resolve(baseDir, "financial-accounts.yaml"),
		senderRules: resolve(baseDir, "sender-rules.yaml"),
		financeAccountMappings: resolve(baseDir, "finance-account-mappings.yaml"),
	};
}

export function ensureOperatorRegistryFiles(baseDir = APP_CONFIG.registryDir) {
	mkdirSync(baseDir, { recursive: true });
	const paths = getRegistryPaths(baseDir);
	writeYamlIfMissing(paths.identities, []);
	writeYamlIfMissing(paths.institutions, []);
	writeYamlIfMissing(paths.financialAccounts, []);
	writeYamlIfMissing(paths.senderRules, []);
	writeYamlIfMissing(paths.financeAccountMappings, []);
	return paths;
}

export function upsertFinanceAccountMappingYaml(
	mapping: FinanceAccountMapping,
	baseDir = APP_CONFIG.registryDir,
) {
	const paths = ensureOperatorRegistryFiles(baseDir);
	const normalized = normalizeFinanceAccountMapping(
		financeAccountMappingSchema.parse(mapping),
	);
	const existing = loadYamlFile(
		paths.financeAccountMappings,
		(input) => financeAccountMappingFileSchema.parse(input),
		[],
	).map(normalizeFinanceAccountMapping);
	const nextByKey = new Map(existing.map((row) => [row.mappingKey, row]));
	nextByKey.set(normalized.mappingKey, normalized);
	const next = sortByMappingKey([...nextByKey.values()]);
	writeFileSync(
		paths.financeAccountMappings,
		`${stringify(next).trimEnd()}\n`,
		"utf8",
	);
	return {
		path: paths.financeAccountMappings,
		count: next.length,
		mappingKey: normalized.mappingKey,
	};
}

export function buildRegistrySha256(input: {
	identities: RegistryIdentity[];
	institutions: RegistryInstitution[];
	financialAccounts: RegistryFinancialAccount[];
	senderRules: RegistrySenderRule[];
	accountMappings: FinanceAccountMapping[];
}) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				identities: sortById(input.identities.map(normalizeRegistryIdentity)),
				institutions: sortById(
					input.institutions.map(normalizeRegistryInstitution),
				),
				financialAccounts: sortById(
					input.financialAccounts.map(normalizeRegistryFinancialAccount),
				),
				senderRules: sortById(
					input.senderRules.map(normalizeRegistrySenderRule),
				),
				accountMappings: sortByMappingKey(
					input.accountMappings.map(normalizeFinanceAccountMapping),
				),
			}),
		)
		.digest("hex");
}

export function extractDomain(value: string | null | undefined) {
	if (!value || !value.includes("@")) {
		return null;
	}
	const parts = value.toLowerCase().split("@");
	return parts[parts.length - 1] || null;
}

export async function importOperatorRegistry(baseDir = APP_CONFIG.registryDir) {
	const paths = ensureOperatorRegistryFiles(baseDir);
	const identities = loadYamlFile(
		paths.identities,
		(input) => registryIdentityFileSchema.parse(input),
		[],
	).map(normalizeRegistryIdentity);
	const institutions = loadYamlFile(
		paths.institutions,
		(input) => registryInstitutionFileSchema.parse(input),
		[],
	).map(normalizeRegistryInstitution);
	const financialAccounts = loadYamlFile(
		paths.financialAccounts,
		(input) => registryFinancialAccountFileSchema.parse(input),
		[],
	).map(normalizeRegistryFinancialAccount);
	const senderRules = loadYamlFile(
		paths.senderRules,
		(input) => registrySenderRuleFileSchema.parse(input),
		[],
	).map(normalizeRegistrySenderRule);
	const accountMappings = loadYamlFile(
		paths.financeAccountMappings,
		(input) => financeAccountMappingFileSchema.parse(input),
		[],
	).map(normalizeFinanceAccountMapping);
	const sha256 = buildRegistrySha256({
		identities,
		institutions,
		financialAccounts,
		senderRules,
		accountMappings,
	});
	const counts = {
		identities: identities.length,
		institutions: institutions.length,
		financialAccounts: financialAccounts.length,
		senderRules: senderRules.length,
		accountMappings: accountMappings.length,
	};
	const db = getDb();
	const importedAt = nowIso();

	await db.transaction().execute(async (trx) => {
		await trx
			.deleteFrom("registry_sender_rules")
			.where("source_kind", "=", "operator")
			.execute();
		await trx.deleteFrom("finance_account_mappings").execute();
		await trx
			.deleteFrom("registry_financial_accounts")
			.where("source_kind", "=", "operator")
			.execute();
		await trx
			.deleteFrom("registry_institutions")
			.where("source_kind", "=", "operator")
			.execute();
		await trx
			.deleteFrom("registry_identities")
			.where("source_kind", "=", "operator")
			.execute();

		if (identities.length > 0) {
			await trx
				.insertInto("registry_identities")
				.values(
					identities.map((identity) => ({
						id: identity.id,
						kind: identity.kind,
						source_kind: "operator",
						display_name: identity.displayName,
						aliases_json: jsonText(identity.aliases),
						email_addresses_json: jsonText(identity.emailAddresses),
						domains_json: jsonText(identity.domains),
						tax_owner_hint: identity.taxOwnerHint,
						notes: identity.notes,
					})),
				)
				.execute();
		}

		if (institutions.length > 0) {
			await trx
				.insertInto("registry_institutions")
				.values(
					institutions.map((institution) => ({
						id: institution.id,
						source_kind: "operator",
						display_name: institution.displayName,
						aliases_json: jsonText(institution.aliases),
						domains_json: jsonText(institution.domains),
						notes: institution.notes,
					})),
				)
				.execute();
		}

		if (financialAccounts.length > 0) {
			await trx
				.insertInto("registry_financial_accounts")
				.values(
					financialAccounts.map((account) => ({
						id: account.id,
						source_kind: "operator",
						institution_id: account.institutionId,
						owner_identity_id: account.ownerIdentityId,
						display_name: account.displayName,
						aliases_json: jsonText(account.aliases),
						account_mask: account.accountMask,
						account_last4: account.accountLast4,
						account_type: account.accountType,
						currency: account.currency,
						tax_owner_hint: account.taxOwnerHint,
						notes: account.notes,
					})),
				)
				.execute();
		}

		if (senderRules.length > 0) {
			await trx
				.insertInto("registry_sender_rules")
				.values(
					senderRules.map((rule) => ({
						id: rule.id,
						source_kind: "operator",
						sender_pattern: rule.senderPattern,
						domain: rule.domain,
						owner_identity_id: rule.ownerIdentityId,
						institution_id: rule.institutionId,
						financial_account_id: rule.financialAccountId,
						message_kind_hint: rule.messageKindHint,
						priority: rule.priority,
						notes: rule.notes,
					})),
				)
				.execute();
		}

		if (accountMappings.length > 0) {
			await trx
				.insertInto("finance_account_mappings")
				.values(
					accountMappings.map((mapping) => ({
						id: randomUUID(),
						mapping_key: mapping.mappingKey,
						book: mapping.book,
						account_name:
							mapping.debitAccount ??
							mapping.creditAccount ??
							mapping.mappingKey,
						account_type: "posting",
						currency: mapping.currency,
						confidence: mapping.confidence,
						source_json: jsonText(mapping),
						debit_account: mapping.debitAccount,
						credit_account: mapping.creditAccount,
						match_json: jsonText(mapping.match),
						notes: mapping.notes,
						source_path: paths.financeAccountMappings,
						created_at: importedAt,
						updated_at: importedAt,
					})),
				)
				.execute();
		}

		await trx
			.insertInto("registry_import_state")
			.values({
				key: REGISTRY_STATE_KEY,
				combined_sha256: sha256,
				source_dir: baseDir,
				counts_json: jsonText(counts),
				imported_at: importedAt,
			})
			.onConflict((oc) =>
				oc.column("key").doUpdateSet({
					combined_sha256: sha256,
					source_dir: baseDir,
					counts_json: jsonText(counts),
					imported_at: importedAt,
				}),
			)
			.execute();

		await trx
			.updateTable("message_secondary_heads")
			.set({
				status: "stale",
				updated_at: importedAt,
			})
			.where("classifier_key", "=", "finance_intel")
			.execute();
	});

	return {
		counts,
		importedAt,
		sha256,
		sourceDir: baseDir,
	};
}

export async function loadOperatorRegistry() {
	ensureOperatorRegistryFiles();
	const db = getDb();
	const [
		identities,
		institutions,
		financialAccounts,
		senderRules,
		accountMappings,
		importState,
	] = await Promise.all([
		db.selectFrom("registry_identities").selectAll().execute(),
		db.selectFrom("registry_institutions").selectAll().execute(),
		db.selectFrom("registry_financial_accounts").selectAll().execute(),
		db.selectFrom("registry_sender_rules").selectAll().execute(),
		db.selectFrom("finance_account_mappings").selectAll().execute(),
		db
			.selectFrom("registry_import_state")
			.selectAll()
			.where("key", "=", REGISTRY_STATE_KEY)
			.executeTakeFirst(),
	]);

	if (
		identities.length === 0 &&
		institutions.length === 0 &&
		financialAccounts.length === 0 &&
		senderRules.length === 0 &&
		accountMappings.length === 0 &&
		!importState
	) {
		return buildEmptyRegistry();
	}

	const snapshot: OperatorRegistrySnapshot = {
		sha256: buildRegistrySha256({
			identities: identities.map((identity) => ({
				id: identity.id,
				kind: identity.kind as RegistryIdentity["kind"],
				displayName: identity.display_name,
				aliases: safeJsonParse(identity.aliases_json, []),
				emailAddresses: safeJsonParse(identity.email_addresses_json, []),
				domains: safeJsonParse(identity.domains_json, []),
				taxOwnerHint: identity.tax_owner_hint,
				notes: identity.notes,
			})),
			institutions: institutions.map((institution) => ({
				id: institution.id,
				displayName: institution.display_name,
				aliases: safeJsonParse(institution.aliases_json, []),
				domains: safeJsonParse(institution.domains_json, []),
				notes: institution.notes,
			})),
			financialAccounts: financialAccounts.map((account) => ({
				id: account.id,
				institutionId: account.institution_id,
				ownerIdentityId: account.owner_identity_id,
				displayName: account.display_name,
				aliases: safeJsonParse(account.aliases_json, []),
				accountMask: account.account_mask,
				accountLast4: account.account_last4,
				accountType: account.account_type,
				currency: account.currency,
				taxOwnerHint: account.tax_owner_hint,
				notes: account.notes,
			})),
			senderRules: senderRules.map((rule) => ({
				id: rule.id,
				senderPattern: rule.sender_pattern,
				domain: rule.domain,
				ownerIdentityId: rule.owner_identity_id,
				institutionId: rule.institution_id,
				financialAccountId: rule.financial_account_id,
				messageKindHint:
					rule.message_kind_hint as RegistrySenderRule["messageKindHint"],
				priority: rule.priority,
				notes: rule.notes,
			})),
			accountMappings: accountMappings.map((mapping) => ({
				mappingKey: mapping.mapping_key,
				book: mapping.book as FinanceAccountMapping["book"],
				match: safeJsonParse(mapping.match_json, {}),
				debitAccount: mapping.debit_account,
				creditAccount: mapping.credit_account,
				currency: mapping.currency,
				confidence: mapping.confidence,
				notes: mapping.notes,
			})),
		}),
		importedAt: importState?.imported_at ?? null,
		sourceDir: importState?.source_dir ?? APP_CONFIG.registryDir,
		identities: identities.map((identity) => ({
			id: identity.id,
			kind: identity.kind as RegistryIdentity["kind"],
			displayName: identity.display_name,
			aliases: safeJsonParse(identity.aliases_json, []),
			emailAddresses: safeJsonParse(identity.email_addresses_json, []),
			domains: safeJsonParse(identity.domains_json, []),
			taxOwnerHint: identity.tax_owner_hint,
			notes: identity.notes,
		})),
		institutions: institutions.map((institution) => ({
			id: institution.id,
			displayName: institution.display_name,
			aliases: safeJsonParse(institution.aliases_json, []),
			domains: safeJsonParse(institution.domains_json, []),
			notes: institution.notes,
		})),
		financialAccounts: financialAccounts.map((account) => ({
			id: account.id,
			institutionId: account.institution_id,
			ownerIdentityId: account.owner_identity_id,
			displayName: account.display_name,
			aliases: safeJsonParse(account.aliases_json, []),
			accountMask: account.account_mask,
			accountLast4: account.account_last4,
			accountType: account.account_type,
			currency: account.currency,
			taxOwnerHint: account.tax_owner_hint,
			notes: account.notes,
		})),
		senderRules: senderRules.map((rule) => ({
			id: rule.id,
			senderPattern: rule.sender_pattern,
			domain: rule.domain,
			ownerIdentityId: rule.owner_identity_id,
			institutionId: rule.institution_id,
			financialAccountId: rule.financial_account_id,
			messageKindHint:
				rule.message_kind_hint as RegistrySenderRule["messageKindHint"],
			priority: rule.priority,
			notes: rule.notes,
		})),
		accountMappings: accountMappings.map((mapping) => ({
			mappingKey: mapping.mapping_key,
			book: mapping.book as FinanceAccountMapping["book"],
			match: safeJsonParse(mapping.match_json, {}),
			debitAccount: mapping.debit_account,
			creditAccount: mapping.credit_account,
			currency: mapping.currency,
			confidence: mapping.confidence,
			notes: mapping.notes,
		})),
	};

	return snapshot;
}

function containsAlias(text: string, aliases: string[]) {
	return aliases.some((alias) => {
		const normalized = alias.trim().toLowerCase();
		return normalized.length >= 3 && text.includes(normalized);
	});
}

function normalizeSearchText(input: {
	accountLabel: string;
	accountEmail: string;
	senderAddress: string | null;
	subject: string | null;
	bodyText: string;
	rootLabel: ReturnType<typeof parseCurrentMessageLabel>;
}) {
	return [
		input.accountLabel,
		input.accountEmail,
		input.senderAddress ?? "",
		input.subject ?? "",
		input.bodyText,
		input.rootLabel?.finance.signal ?? "",
		input.rootLabel?.finance.evidence ?? "",
	]
		.join("\n")
		.toLowerCase();
}

function uniqueById<T extends { id: string }>(rows: T[]) {
	const unique = new Map<string, T>();
	for (const row of rows) {
		if (!unique.has(row.id)) {
			unique.set(row.id, row);
		}
	}
	return [...unique.values()];
}

function matchAccountLast4(text: string, account: RegistryFinancialAccount) {
	if (!account.accountLast4) {
		return false;
	}
	return new RegExp(`(^|[^0-9])${account.accountLast4}([^0-9]|$)`, "i").test(
		text,
	);
}

function normalizeScalarList(value: unknown) {
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter(Boolean);
	}
	return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function fieldMatches(value: unknown, matcher: (candidate: string) => boolean) {
	const candidates = normalizeScalarList(value);
	if (candidates.length === 0) {
		return null;
	}
	return candidates.some((candidate) => matcher(candidate));
}

function mappingHasExplicitMatch(mapping: FinanceAccountMapping) {
	return [
		"senderAddress",
		"senderDomain",
		"senderContains",
		"textIncludes",
		"book",
		"ownerIdentityId",
		"institutionId",
		"financialAccountId",
		"accountLast4",
	].some((field) => Object.hasOwn(mapping.match, field));
}

function matchFinanceAccountMapping(input: {
	mapping: FinanceAccountMapping;
	senderAddress: string;
	senderDomain: string | null;
	searchText: string;
	rootBook: string | null;
	matchedIdentityIds: Set<string>;
	matchedInstitutionIds: Set<string>;
	matchedFinancialAccountIds: Set<string>;
}) {
	const match = input.mapping.match;
	const checks: Array<boolean | null> = [
		fieldMatches(
			match.senderAddress,
			(candidate) => candidate.toLowerCase() === input.senderAddress,
		),
		fieldMatches(
			match.senderDomain,
			(candidate) => candidate.toLowerCase() === input.senderDomain,
		),
		fieldMatches(match.senderContains, (candidate) =>
			input.senderAddress.includes(candidate.toLowerCase()),
		),
		fieldMatches(match.textIncludes, (candidate) =>
			input.searchText.includes(candidate.toLowerCase()),
		),
		fieldMatches(match.book, (candidate) => candidate === input.rootBook),
		fieldMatches(match.ownerIdentityId, (candidate) =>
			input.matchedIdentityIds.has(candidate),
		),
		fieldMatches(match.institutionId, (candidate) =>
			input.matchedInstitutionIds.has(candidate),
		),
		fieldMatches(match.financialAccountId, (candidate) =>
			input.matchedFinancialAccountIds.has(candidate),
		),
		fieldMatches(match.accountLast4, (candidate) =>
			new RegExp(`(^|[^0-9])${candidate}([^0-9]|$)`, "i").test(
				input.searchText,
			),
		),
	];
	if (checks.some((check) => check === false)) {
		return false;
	}
	const explicitPositive = checks.some((check) => check === true);
	const referencedPositive =
		fieldMatches(match.ownerIdentityId, (candidate) =>
			input.matchedIdentityIds.has(candidate),
		) === true ||
		fieldMatches(match.institutionId, (candidate) =>
			input.matchedInstitutionIds.has(candidate),
		) === true ||
		fieldMatches(match.financialAccountId, (candidate) =>
			input.matchedFinancialAccountIds.has(candidate),
		) === true;
	if (explicitPositive) {
		return true;
	}
	return !mappingHasExplicitMatch(input.mapping) ? referencedPositive : false;
}

function sortMatchedMappings(rows: FinanceAccountMapping[]) {
	return [...rows]
		.sort((left, right) => {
			const confidenceOrder = right.confidence - left.confidence;
			return confidenceOrder || left.mappingKey.localeCompare(right.mappingKey);
		})
		.slice(0, 20);
}

export async function matchRegistryForMessage(input: {
	accountLabel: string;
	accountEmail: string;
	senderAddress: string | null;
	subject: string | null;
	bodyText: string;
	rootLabel: unknown;
}) {
	const registry = await loadOperatorRegistry();
	const senderAddress = input.senderAddress?.toLowerCase() ?? "";
	const senderDomain = extractDomain(senderAddress);
	const accountEmail = input.accountEmail.toLowerCase();
	const accountDomain = extractDomain(accountEmail);
	const rootLabel = parseCurrentMessageLabel(input.rootLabel);
	const searchText = normalizeSearchText({
		...input,
		rootLabel,
	});

	const matchedIdentities = registry.identities.filter((identity) => {
		return (
			identity.emailAddresses.includes(accountEmail) ||
			(accountDomain ? identity.domains.includes(accountDomain) : false) ||
			containsAlias(searchText, identity.aliases)
		);
	});

	const matchedInstitutions = registry.institutions.filter((institution) => {
		return (
			Boolean(senderDomain && institution.domains.includes(senderDomain)) ||
			containsAlias(searchText, institution.aliases)
		);
	});

	const matchedFinancialAccounts = registry.financialAccounts.filter(
		(account) => {
			return (
				containsAlias(searchText, account.aliases) ||
				matchAccountLast4(searchText, account) ||
				(account.institutionId
					? matchedInstitutions.some(
							(institution) => institution.id === account.institutionId,
						)
					: false) ||
				(account.ownerIdentityId
					? matchedIdentities.some(
							(identity) => identity.id === account.ownerIdentityId,
						)
					: false)
			);
		},
	);

	const matchedSenderRules = sortById(registry.senderRules)
		.sort((left, right) => left.priority - right.priority)
		.filter((rule) => {
			if (rule.domain && rule.domain !== senderDomain) {
				return false;
			}
			return (
				senderAddress.includes(rule.senderPattern) ||
				searchText.includes(rule.senderPattern)
			);
		});

	const identitiesById = new Map(
		registry.identities.map((identity) => [identity.id, identity]),
	);
	const institutionsById = new Map(
		registry.institutions.map((institution) => [institution.id, institution]),
	);
	const financialAccountsById = new Map(
		registry.financialAccounts.map((account) => [account.id, account]),
	);
	const senderRuleIdentityRows = matchedSenderRules
		.flatMap((rule) => (rule.ownerIdentityId ? [rule.ownerIdentityId] : []))
		.map((id) => identitiesById.get(id))
		.filter((identity): identity is RegistryIdentity => Boolean(identity));
	const senderRuleInstitutionRows = matchedSenderRules
		.flatMap((rule) => (rule.institutionId ? [rule.institutionId] : []))
		.map((id) => institutionsById.get(id))
		.filter((institution): institution is RegistryInstitution =>
			Boolean(institution),
		);
	const senderRuleAccountRows = matchedSenderRules
		.flatMap((rule) =>
			rule.financialAccountId ? [rule.financialAccountId] : [],
		)
		.map((id) => financialAccountsById.get(id))
		.filter((account): account is RegistryFinancialAccount => Boolean(account));

	matchedIdentities.push(...senderRuleIdentityRows);
	matchedInstitutions.push(...senderRuleInstitutionRows);
	matchedFinancialAccounts.push(...senderRuleAccountRows);

	const uniqueIdentities = uniqueById(matchedIdentities);
	const uniqueInstitutions = uniqueById(matchedInstitutions);
	const uniqueFinancialAccounts = uniqueById(matchedFinancialAccounts);
	const matchedIdentityIds = new Set(uniqueIdentities.map((row) => row.id));
	const matchedInstitutionIds = new Set(
		uniqueInstitutions.map((row) => row.id),
	);
	const matchedFinancialAccountIds = new Set(
		uniqueFinancialAccounts.map((row) => row.id),
	);
	const accountMappings = sortMatchedMappings(
		registry.accountMappings.filter((mapping) =>
			matchFinanceAccountMapping({
				mapping,
				senderAddress,
				senderDomain,
				searchText,
				rootBook: rootLabel?.finance.bookHint ?? null,
				matchedIdentityIds,
				matchedInstitutionIds,
				matchedFinancialAccountIds,
			}),
		),
	);

	return {
		sha256: registry.sha256,
		identities: uniqueIdentities,
		institutions: uniqueInstitutions,
		financialAccounts: uniqueFinancialAccounts,
		senderRules: uniqueById(matchedSenderRules),
		accountMappings,
	} satisfies RegistryMatchResult;
}

function normalizeHintKey(input: string) {
	return input
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 160);
}

function hintRows(input: {
	secondaryResultId: string;
	messageId: string;
	financeIntel: FinanceIntelV3;
}) {
	const confidence = Math.min(input.financeIntel.confidence.overall, 0.8);
	const groups = [
		{
			kind: "identity",
			hints: input.financeIntel.unresolvedEntityHints.identityHints,
		},
		{
			kind: "institution",
			hints: input.financeIntel.unresolvedEntityHints.institutionHints,
		},
		{
			kind: "financial_account",
			hints: input.financeIntel.unresolvedEntityHints.financialAccountHints,
		},
	] as const;
	return groups.flatMap((group) =>
		group.hints.flatMap((hint) => {
			const normalized = normalizeHintKey(hint);
			if (!normalized) {
				return [];
			}
			return [
				{
					id: randomUUID(),
					entity_kind: group.kind,
					canonical_key: `email-hint:${group.kind}:${normalized}`,
					suggestion_json: jsonText({
						displayName: hint.trim(),
						aliases: [hint.trim()],
						messageId: input.messageId,
					}),
					source_kind: "email_finance_intel",
					source_ref_id: input.secondaryResultId,
					confidence,
					status: "pending",
					applied_registry_id: null,
					created_at: nowIso(),
					updated_at: nowIso(),
				},
			];
		}),
	);
}

export async function persistEmailFinanceHintSuggestions(input: {
	secondaryResultId: string;
	messageId: string;
	financeIntel: FinanceIntelV3;
}) {
	const rows = hintRows(input);
	if (rows.length === 0) {
		return 0;
	}
	const db = getDb();
	await db.insertInto("registry_suggestions").values(rows).execute();
	await queueJobIdempotent({
		kind: "reconcile_registry_suggestions",
		scopeType: "system",
		scopeId: "registry_suggestions",
	});
	await publishActionEvent({
		topic: "finance",
		eventType: "finance.registry_suggestions_created",
		entityKind: "message_secondary_result",
		entityId: input.secondaryResultId,
		payload: {
			secondaryResultId: input.secondaryResultId,
			messageId: input.messageId,
			count: rows.length,
		},
	});
	return rows.length;
}

export async function reconcileRegistrySuggestions() {
	const db = getDb();
	const suggestions = await db
		.selectFrom("registry_suggestions")
		.selectAll()
		.where("status", "=", "pending")
		.orderBy("entity_kind", "asc")
		.orderBy("canonical_key", "asc")
		.orderBy("confidence", "desc")
		.execute();

	let applied = 0;
	let pending = 0;
	let superseded = 0;

	const groups = new Map<string, typeof suggestions>();
	for (const suggestion of suggestions) {
		const key = `${suggestion.entity_kind}:${suggestion.canonical_key}`;
		const current = groups.get(key) ?? [];
		current.push(suggestion);
		groups.set(key, current);
	}

	await db.transaction().execute(async (trx) => {
		for (const rows of groups.values()) {
			const [winner, ...rest] = rows;
			if (!winner) {
				continue;
			}

			for (const row of rest) {
				await trx
					.updateTable("registry_suggestions")
					.set({
						status: "superseded",
						updated_at: nowIso(),
					})
					.where("id", "=", row.id)
					.execute();
				superseded += 1;
			}

			if (winner.confidence < 0.95) {
				pending += 1;
				continue;
			}

			const payload = safeJsonParse<Record<string, unknown> | null>(
				winner.suggestion_json,
				null,
			);
			if (!payload) {
				pending += 1;
				continue;
			}

			let appliedRegistryId: string | null = null;
			switch (winner.entity_kind) {
				case "identity":
					appliedRegistryId = randomUUID();
					await trx
						.insertInto("registry_identities")
						.values({
							id: appliedRegistryId,
							kind: String(payload.kind ?? "personal"),
							source_kind: "suggestion",
							display_name: String(payload.displayName ?? winner.canonical_key),
							aliases_json: jsonText(payload.aliases ?? []),
							email_addresses_json: jsonText(payload.emailAddresses ?? []),
							domains_json: jsonText(payload.domains ?? []),
							tax_owner_hint:
								typeof payload.taxOwnerHint === "string"
									? payload.taxOwnerHint
									: null,
							notes: typeof payload.notes === "string" ? payload.notes : null,
						})
						.execute();
					break;
				case "institution":
					appliedRegistryId = randomUUID();
					await trx
						.insertInto("registry_institutions")
						.values({
							id: appliedRegistryId,
							source_kind: "suggestion",
							display_name: String(payload.displayName ?? winner.canonical_key),
							aliases_json: jsonText(payload.aliases ?? []),
							domains_json: jsonText(payload.domains ?? []),
							notes: typeof payload.notes === "string" ? payload.notes : null,
						})
						.execute();
					break;
				case "financial_account":
					appliedRegistryId = randomUUID();
					await trx
						.insertInto("registry_financial_accounts")
						.values({
							id: appliedRegistryId,
							source_kind: "suggestion",
							institution_id:
								typeof payload.institutionId === "string"
									? payload.institutionId
									: null,
							owner_identity_id:
								typeof payload.ownerIdentityId === "string"
									? payload.ownerIdentityId
									: null,
							display_name: String(payload.displayName ?? winner.canonical_key),
							aliases_json: jsonText(payload.aliases ?? []),
							account_mask:
								typeof payload.accountMask === "string"
									? payload.accountMask
									: null,
							account_last4:
								typeof payload.accountLast4 === "string"
									? payload.accountLast4
									: null,
							account_type:
								typeof payload.accountType === "string"
									? payload.accountType
									: null,
							currency:
								typeof payload.currency === "string" ? payload.currency : null,
							tax_owner_hint:
								typeof payload.taxOwnerHint === "string"
									? payload.taxOwnerHint
									: null,
							notes: typeof payload.notes === "string" ? payload.notes : null,
						})
						.execute();
					break;
				case "sender_rule":
					appliedRegistryId = randomUUID();
					await trx
						.insertInto("registry_sender_rules")
						.values({
							id: appliedRegistryId,
							source_kind: "suggestion",
							sender_pattern: String(
								payload.senderPattern ?? winner.canonical_key,
							).toLowerCase(),
							domain:
								typeof payload.domain === "string"
									? payload.domain.toLowerCase()
									: null,
							owner_identity_id:
								typeof payload.ownerIdentityId === "string"
									? payload.ownerIdentityId
									: null,
							institution_id:
								typeof payload.institutionId === "string"
									? payload.institutionId
									: null,
							financial_account_id:
								typeof payload.financialAccountId === "string"
									? payload.financialAccountId
									: null,
							message_kind_hint:
								typeof payload.messageKindHint === "string"
									? payload.messageKindHint
									: null,
							priority:
								typeof payload.priority === "number" ? payload.priority : 100,
							notes: typeof payload.notes === "string" ? payload.notes : null,
						})
						.execute();
					break;
				default:
					break;
			}

			if (!appliedRegistryId) {
				pending += 1;
				continue;
			}

			await trx
				.updateTable("registry_suggestions")
				.set({
					status: "applied",
					applied_registry_id: appliedRegistryId,
					updated_at: nowIso(),
				})
				.where("id", "=", winner.id)
				.execute();
			applied += 1;
		}
	});

	return {
		applied,
		pending,
		superseded,
	};
}
