import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "kysely";
import { parse, stringify } from "yaml";

import { APP_CONFIG, nowIso } from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import {
	type ClassificationRule,
	classificationRulesFileSchema,
	type FinanceIntelV3,
	type FinanceTaxonomyFile,
	financeTaxonomyFileSchema,
	type MessageLabelV3,
	parseCurrentFinanceIntel,
	parseCurrentMessageLabel,
	type RootTaxonomyFile,
	type RuleProjectionSource,
	rootTaxonomyFileSchema,
} from "#/lib/schemas";

const ROOT_TAXONOMY_KEY = "root_taxonomy";
const FINANCE_TAXONOMY_KEY = "finance_taxonomy";
const RULES_KEY = "rules";

const DEFAULT_ROOT_TAXONOMY: RootTaxonomyFile = {
	schemaVersion: "root-taxonomy.v1",
	primaryBuckets: [
		"finance",
		"work",
		"relationships",
		"knowledge",
		"assets",
		"entertainment",
		"system",
		"other",
	],
	secondaryBuckets: [
		"gaming",
		"networking",
		"community",
		"recruiting",
		"courses",
		"resources",
		"documentation",
		"newsletter",
		"receipt",
		"invoice",
		"statement",
		"subscription",
		"promotion",
		"travel",
		"shopping",
		"tax",
		"banking",
		"payroll",
		"donation",
		"legal",
		"security",
		"ops",
	],
};

const DEFAULT_FINANCE_TAXONOMY: FinanceTaxonomyFile = {
	schemaVersion: "finance-taxonomy.v1",
	categories: [
		{ primary: "income", secondary: ["salary", "refund", "reimbursement"] },
		{ primary: "housing", secondary: ["rent", "mortgage"] },
		{ primary: "utilities", secondary: ["electric", "internet", "phone"] },
		{ primary: "banking_fees", secondary: ["service_fee", "interest"] },
		{ primary: "transfers", secondary: ["internal_transfer", "wire"] },
		{ primary: "taxes", secondary: ["estimated_tax", "tax_notice"] },
		{ primary: "insurance", secondary: ["premium"] },
		{ primary: "healthcare", secondary: ["medical"] },
		{ primary: "travel", secondary: ["flight", "lodging", "transport"] },
		{ primary: "meals", secondary: ["restaurant", "coffee"] },
		{ primary: "shopping", secondary: ["retail", "supplies"] },
		{
			primary: "software_services",
			secondary: ["saas", "hosting", "ai_tools"],
		},
		{ primary: "education", secondary: ["course", "book"] },
		{ primary: "office_business", secondary: ["office", "equipment"] },
		{ primary: "payroll_contractors", secondary: ["payroll", "contractor"] },
		{ primary: "investments", secondary: ["brokerage", "dividend"] },
		{ primary: "donations", secondary: ["charity"] },
		{ primary: "subscriptions", secondary: ["membership"] },
		{ primary: "uncategorized", secondary: [] },
	],
};

const DEFAULT_RULES = classificationRulesFileSchema.parse({
	schemaVersion: "classification-rules.v1" as const,
	rules: [
		{
			key: "finance-receipt-shopping",
			description: "Map receipt-like finance emails to shopping secondary.",
			priority: 20,
			enabled: true,
			match: {
				rootPrimaryBucket: "finance",
				financeMessageKind: "receipt",
			},
			projection: {
				source: "overlay_rule" as RuleProjectionSource,
				primaryCategory: "finance" as const,
				secondaryCategory: "shopping" as const,
			},
		},
		{
			key: "networking-people",
			description: "Networking mail should land in relationships.",
			priority: 30,
			enabled: true,
			match: {
				rootSecondaryBucket: "networking" as const,
			},
			projection: {
				source: "overlay_rule" as RuleProjectionSource,
				primaryCategory: "relationships" as const,
				secondaryCategory: "networking" as const,
			},
		},
		{
			key: "course-knowledge",
			description: "Course mail should land in knowledge.",
			priority: 30,
			enabled: true,
			match: {
				rootSecondaryBucket: "courses" as const,
			},
			projection: {
				source: "overlay_rule" as RuleProjectionSource,
				primaryCategory: "knowledge" as const,
				secondaryCategory: "courses" as const,
			},
		},
	],
});

export function getClassificationPaths(baseDir = APP_CONFIG.classificationDir) {
	return {
		rootTaxonomy: resolve(baseDir, "root-taxonomy.yaml"),
		financeTaxonomy: resolve(baseDir, "finance-taxonomy.yaml"),
		rules: resolve(baseDir, "rules.yaml"),
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

export function ensureClassificationConfigFiles(
	baseDir = APP_CONFIG.classificationDir,
) {
	mkdirSync(baseDir, { recursive: true });
	const paths = getClassificationPaths(baseDir);
	writeYamlIfMissing(paths.rootTaxonomy, DEFAULT_ROOT_TAXONOMY);
	writeYamlIfMissing(paths.financeTaxonomy, DEFAULT_FINANCE_TAXONOMY);
	writeYamlIfMissing(paths.rules, {
		schemaVersion: "classification-rules.v1",
		rules: DEFAULT_RULES.rules,
	});
	return paths;
}

function readClassificationConfigFromDisk(
	baseDir = APP_CONFIG.classificationDir,
) {
	const paths = ensureClassificationConfigFiles(baseDir);
	return {
		rootTaxonomy: loadYamlFile(
			paths.rootTaxonomy,
			(input) => rootTaxonomyFileSchema.parse(input),
			DEFAULT_ROOT_TAXONOMY,
		),
		financeTaxonomy: loadYamlFile(
			paths.financeTaxonomy,
			(input) => financeTaxonomyFileSchema.parse(input),
			DEFAULT_FINANCE_TAXONOMY,
		),
		rules: loadYamlFile(
			paths.rules,
			(input) => classificationRulesFileSchema.parse(input).rules,
			DEFAULT_RULES.rules,
		),
		paths,
	};
}

function sha256(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isMissingClassificationTableError(error: unknown) {
	return error instanceof Error && error.message.includes("no such table");
}

export interface LoadedClassificationConfig {
	rootTaxonomy: RootTaxonomyFile;
	financeTaxonomy: FinanceTaxonomyFile;
	rules: ClassificationRule[];
	sha256: string;
}

function buildLoadedConfig(input: {
	rootTaxonomy: RootTaxonomyFile;
	financeTaxonomy: FinanceTaxonomyFile;
	rules: ClassificationRule[];
}): LoadedClassificationConfig {
	return {
		...input,
		sha256: sha256(input),
	};
}

export async function importClassificationConfig(
	baseDir = APP_CONFIG.classificationDir,
): Promise<LoadedClassificationConfig> {
	ensureClassificationConfigFiles(baseDir);
	const { rootTaxonomy, financeTaxonomy, rules, paths } =
		readClassificationConfigFromDisk(baseDir);

	const db = getDb();
	const importedAt = nowIso();
	const ruleRows = rules.map((rule) => ({
		id: randomUUID(),
		rule_set_key: RULES_KEY,
		rule_key: rule.key,
		priority: rule.priority,
		enabled: rule.enabled ? 1 : 0,
		match_json: jsonText(rule.match),
		projection_json: jsonText(rule.projection),
		created_at: importedAt,
	}));

	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("classification_rule_sets")
			.values([
				{
					key: ROOT_TAXONOMY_KEY,
					schema_version: rootTaxonomy.schemaVersion,
					source_path: paths.rootTaxonomy,
					sha256: sha256(rootTaxonomy),
					payload_json: jsonText(rootTaxonomy),
					imported_at: importedAt,
				},
				{
					key: FINANCE_TAXONOMY_KEY,
					schema_version: financeTaxonomy.schemaVersion,
					source_path: paths.financeTaxonomy,
					sha256: sha256(financeTaxonomy),
					payload_json: jsonText(financeTaxonomy),
					imported_at: importedAt,
				},
				{
					key: RULES_KEY,
					schema_version: "classification-rules.v1",
					source_path: paths.rules,
					sha256: sha256({ rules }),
					payload_json: jsonText({
						schemaVersion: "classification-rules.v1",
						rules,
					}),
					imported_at: importedAt,
				},
			])
			.onConflict((oc) =>
				oc.column("key").doUpdateSet((eb) => ({
					schema_version: eb.ref("excluded.schema_version"),
					source_path: eb.ref("excluded.source_path"),
					sha256: eb.ref("excluded.sha256"),
					payload_json: eb.ref("excluded.payload_json"),
					imported_at: eb.ref("excluded.imported_at"),
				})),
			)
			.execute();

		await trx
			.deleteFrom("classification_rules")
			.where("rule_set_key", "=", RULES_KEY)
			.execute();
		if (ruleRows.length > 0) {
			await trx.insertInto("classification_rules").values(ruleRows).execute();
		}
	});

	return loadClassificationConfig();
}

export async function loadClassificationConfig(): Promise<LoadedClassificationConfig> {
	const db = getDb();
	let ruleSets: Array<{
		key: string;
		sha256: string;
		payload_json: string;
	}>;
	let rules: Array<{
		rule_key: string;
		priority: number;
		enabled: number;
		match_json: string;
		projection_json: string;
	}>;
	try {
		[ruleSets, rules] = (await Promise.all([
			db.selectFrom("classification_rule_sets").selectAll().execute(),
			db
				.selectFrom("classification_rules")
				.selectAll()
				.where("rule_set_key", "=", RULES_KEY)
				.orderBy("priority", "asc")
				.orderBy("rule_key", "asc")
				.execute(),
		])) as [typeof ruleSets, typeof rules];
	} catch (error) {
		if (isMissingClassificationTableError(error)) {
			const diskConfig = readClassificationConfigFromDisk();
			return buildLoadedConfig({
				rootTaxonomy: diskConfig.rootTaxonomy,
				financeTaxonomy: diskConfig.financeTaxonomy,
				rules: diskConfig.rules,
			});
		}
		throw error;
	}

	const diskConfig = readClassificationConfigFromDisk();
	const byKey = new Map(ruleSets.map((row) => [row.key, row]));
	const rootSha = sha256(diskConfig.rootTaxonomy);
	const financeSha = sha256(diskConfig.financeTaxonomy);
	const rulesSha = sha256({ rules: diskConfig.rules });
	if (
		ruleSets.length === 0 ||
		byKey.get(ROOT_TAXONOMY_KEY)?.sha256 !== rootSha ||
		byKey.get(FINANCE_TAXONOMY_KEY)?.sha256 !== financeSha ||
		byKey.get(RULES_KEY)?.sha256 !== rulesSha
	) {
		return importClassificationConfig();
	}

	return buildLoadedConfig({
		rootTaxonomy: safeJsonParse(
			byKey.get(ROOT_TAXONOMY_KEY)?.payload_json ?? null,
			DEFAULT_ROOT_TAXONOMY,
		),
		financeTaxonomy: safeJsonParse(
			byKey.get(FINANCE_TAXONOMY_KEY)?.payload_json ?? null,
			DEFAULT_FINANCE_TAXONOMY,
		),
		rules: rules.map((row) => ({
			key: row.rule_key,
			priority: row.priority,
			enabled: row.enabled === 1,
			match: safeJsonParse(row.match_json, {}),
			projection: safeJsonParse(row.projection_json, {}),
		})) as ClassificationRule[],
	});
}

function extractDomain(value: string | null | undefined) {
	if (!value || !value.includes("@")) {
		return null;
	}
	const parts = value.toLowerCase().split("@");
	return parts[parts.length - 1] ?? null;
}

function matchesRule(input: {
	rule: ClassificationRule;
	message: {
		accountLabel: string;
		accountEmail: string;
		senderAddress: string | null;
		subject: string | null;
		attachments: Array<{ filename: string | null; mime_type: string | null }>;
	};
	rootLabel: MessageLabelV3;
	financeIntel: FinanceIntelV3 | null;
}) {
	const { match } = input.rule;
	if (match.senderDomain) {
		if (
			extractDomain(input.message.senderAddress) !==
			match.senderDomain.toLowerCase()
		) {
			return false;
		}
	}
	if (match.senderIncludes) {
		if (
			!(input.message.senderAddress ?? "")
				.toLowerCase()
				.includes(match.senderIncludes.toLowerCase())
		) {
			return false;
		}
	}
	if (match.accountLabel) {
		if (input.message.accountLabel !== match.accountLabel) {
			return false;
		}
	}
	if (match.accountEmail) {
		if (
			input.message.accountEmail.toLowerCase() !==
			match.accountEmail.toLowerCase()
		) {
			return false;
		}
	}
	if (match.rootPrimaryBucket) {
		if (input.rootLabel.routing.primaryBucket !== match.rootPrimaryBucket) {
			return false;
		}
	}
	if (match.rootSecondaryBucket) {
		if (
			!input.rootLabel.routing.secondaryBuckets.includes(
				match.rootSecondaryBucket,
			)
		) {
			return false;
		}
	}
	if (match.rootTag) {
		if (!input.rootLabel.routing.tags.includes(match.rootTag)) {
			return false;
		}
	}
	if (match.financeMessageKind) {
		if (input.financeIntel?.messageKind !== match.financeMessageKind) {
			return false;
		}
	}
	if (match.financeActionability) {
		if (input.financeIntel?.actionability !== match.financeActionability) {
			return false;
		}
	}
	if (match.hasAttachmentMimePrefix) {
		if (
			!input.message.attachments.some((attachment) =>
				(attachment.mime_type ?? "").startsWith(
					match.hasAttachmentMimePrefix ?? "",
				),
			)
		) {
			return false;
		}
	}
	return true;
}

export async function projectMessageCategoryAssignment(messageId: string) {
	const db = getDb();
	let config: LoadedClassificationConfig;
	let message: {
		id: string;
		content_sha256: string | null;
		sender_address: string | null;
		subject: string | null;
		account_label: string;
		account_email: string;
		label_json: string | null;
		finance_result_id: string | null;
		finance_result_json: string | null;
	} | null;
	try {
		config = await loadClassificationConfig();
		message = await db
			.selectFrom("messages")
			.innerJoin("accounts", "accounts.id", "messages.account_id")
			.leftJoin("message_labels", "message_labels.message_id", "messages.id")
			.leftJoin("message_secondary_heads", (join) =>
				join
					.onRef("message_secondary_heads.message_id", "=", "messages.id")
					.on("message_secondary_heads.classifier_key", "=", "finance_intel"),
			)
			.leftJoin(
				"message_secondary_results",
				"message_secondary_results.id",
				"message_secondary_heads.secondary_result_id",
			)
			.select([
				"messages.id",
				"messages.content_sha256",
				"messages.sender_address",
				"messages.subject",
				"accounts.label as account_label",
				"accounts.email_address as account_email",
				"message_labels.label_json",
				"message_secondary_results.id as finance_result_id",
				"message_secondary_results.result_json as finance_result_json",
			])
			.where("messages.id", "=", messageId)
			.executeTakeFirstOrThrow();
	} catch (error) {
		if (isMissingClassificationTableError(error)) {
			return null;
		}
		throw error;
	}

	const rootLabel = parseCurrentMessageLabel(
		safeJsonParse(message.label_json ?? null, null),
	);
	if (!rootLabel) {
		return null;
	}

	const attachments = await db
		.selectFrom("attachments")
		.select(["filename", "mime_type"])
		.where("message_id", "=", messageId)
		.execute();
	const financeIntel = parseCurrentFinanceIntel(
		safeJsonParse(message.finance_result_json ?? null, null),
	);

	let source: RuleProjectionSource = "root_model";
	let matchedRuleKey: string | null = null;
	let primaryCategory = rootLabel.routing.primaryBucket;
	let secondaryCategory = rootLabel.routing.secondaryBuckets[0] ?? null;
	let financePrimary =
		financeIntel?.transactionCandidates.find(
			(candidate) => candidate.categoryPrimary,
		)?.categoryPrimary ?? null;
	let financeSecondary =
		financeIntel?.transactionCandidates.find(
			(candidate) => candidate.categorySecondary,
		)?.categorySecondary ?? null;

	if (financePrimary || financeSecondary) {
		source = "finance_secondary";
	}

	for (const rule of config.rules.filter(
		(entry: ClassificationRule) => entry.enabled,
	)) {
		if (
			!matchesRule({
				rule,
				message: {
					accountLabel: message.account_label,
					accountEmail: message.account_email,
					senderAddress: message.sender_address,
					subject: message.subject,
					attachments,
				},
				rootLabel,
				financeIntel,
			})
		) {
			continue;
		}

		matchedRuleKey = rule.key;
		source = rule.projection.source;
		primaryCategory = rule.projection.primaryCategory ?? primaryCategory;
		secondaryCategory = rule.projection.secondaryCategory ?? secondaryCategory;
		financePrimary = rule.projection.financePrimary ?? financePrimary;
		financeSecondary = rule.projection.financeSecondary ?? financeSecondary;
		break;
	}

	const assignmentId = randomUUID();
	const createdAt = nowIso();
	const result = {
		source,
		primaryCategory,
		secondaryCategory,
		financePrimary,
		financeSecondary,
		rootSchemaVersion: rootLabel.schemaVersion,
		financeSchemaVersion: financeIntel?.schemaVersion ?? null,
	};

	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("message_category_assignments")
			.values({
				id: assignmentId,
				message_id: messageId,
				source,
				matched_rule_key: matchedRuleKey,
				projected_primary_category: primaryCategory,
				projected_secondary_category: secondaryCategory,
				projected_finance_primary: financePrimary,
				projected_finance_secondary: financeSecondary,
				result_json: jsonText(result),
				input_content_sha256: message.content_sha256,
				rule_set_sha256: config.sha256,
				finance_result_id: message.finance_result_id ?? null,
				created_at: createdAt,
			})
			.execute();

		await trx
			.insertInto("message_category_assignment_heads")
			.values({
				message_id: messageId,
				assignment_id: assignmentId,
				source,
				input_content_sha256: message.content_sha256,
				rule_set_sha256: config.sha256,
				finance_result_id: message.finance_result_id ?? null,
				updated_at: createdAt,
			})
			.onConflict((oc) =>
				oc.column("message_id").doUpdateSet({
					assignment_id: assignmentId,
					source,
					input_content_sha256: message.content_sha256,
					rule_set_sha256: config.sha256,
					finance_result_id: message.finance_result_id ?? null,
					updated_at: createdAt,
				}),
			)
			.execute();
	});

	return {
		id: assignmentId,
		...result,
	};
}

export async function rebuildMessageCategoryAssignments(messageIds?: string[]) {
	const pendingMessageIds = await listPendingMessageCategoryAssignmentIds({
		messageIds,
		limit: 500,
	});

	let projected = 0;
	for (const messageId of pendingMessageIds) {
		const result = await projectMessageCategoryAssignment(messageId);
		if (result) {
			projected += 1;
		}
	}

	return { projected };
}

export async function listPendingMessageCategoryAssignmentIds(input?: {
	messageIds?: string[];
	limit?: number;
}) {
	const db = getDb();
	const config = await loadClassificationConfig();
	let rows: Array<{ id: string }>;
	try {
		let query = db
			.selectFrom("messages")
			.innerJoin("message_labels", "message_labels.message_id", "messages.id")
			.leftJoin(
				"message_category_assignment_heads",
				"message_category_assignment_heads.message_id",
				"messages.id",
			)
			.leftJoin("message_secondary_heads as finance_heads", (join) =>
				join
					.onRef("finance_heads.message_id", "=", "messages.id")
					.on("finance_heads.classifier_key", "=", "finance_intel"),
			)
			.select(["messages.id"])
			.$if(Boolean(input?.messageIds?.length), (qb) =>
				qb.where("messages.id", "in", input?.messageIds ?? []),
			);

		if (!input?.messageIds?.length) {
			query = query.where((eb) =>
				eb.or([
					eb("message_category_assignment_heads.message_id", "is", null),
					eb(
						"message_category_assignment_heads.input_content_sha256",
						"!=",
						eb.ref("messages.content_sha256"),
					),
					eb(
						"message_category_assignment_heads.rule_set_sha256",
						"!=",
						config.sha256,
					),
					eb(
						sql<string>`coalesce(message_category_assignment_heads.finance_result_id, '')`,
						"!=",
						sql<string>`coalesce(finance_heads.secondary_result_id, '')`,
					),
				]),
			);
		}

		rows = await query
			.orderBy("messages.received_at", "desc")
			.orderBy("messages.id", "desc")
			.limit(input?.limit ?? Number.MAX_SAFE_INTEGER)
			.execute();
	} catch (error) {
		if (isMissingClassificationTableError(error)) {
			return [];
		}
		throw error;
	}

	return rows.map((row) => row.id);
}
