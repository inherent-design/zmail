import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeMessageLabelForPrompt } from "#/lib/classify";
import { APP_CONFIG, nowIso, PROMPTS_DIR } from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { piJson } from "#/lib/pi";
import {
	type OverseerProfileV1,
	overseerProfileJsonSchema,
	overseerProfileSchema,
	parseCurrentMessageLabel,
} from "#/lib/schemas";

function readPrompt(name: string) {
	return readFileSync(resolve(PROMPTS_DIR, name), "utf8");
}

export function topValues(
	entries: Array<{ value: string; count: number }>,
	limit: number,
) {
	return entries
		.sort((left, right) => right.count - left.count)
		.slice(0, limit)
		.map((entry) => entry.value);
}

export function extractDomain(address: string | null) {
	if (!address || !address.includes("@")) {
		return null;
	}
	const parts = address.toLowerCase().split("@");
	return parts[parts.length - 1];
}

function buildReviewPromptExamples(
	reviews: Array<{
		override_label_json: string | null;
		reviewer_note: string | null;
		sender_address: string | null;
		subject: string | null;
		source_result_json: string;
	}>,
) {
	return reviews.slice(0, 40).map((review) => {
		const before = summarizeMessageLabelForPrompt(
			safeJsonParse(review.source_result_json, null),
		);
		const override = review.override_label_json
			? summarizeMessageLabelForPrompt(
					safeJsonParse(review.override_label_json, null),
				)
			: null;
		return {
			sender: review.sender_address,
			subject: review.subject,
			decision: override ? "overridden" : "accepted",
			reviewerNote: review.reviewer_note,
			before,
			after: override ?? before,
		};
	});
}

export async function buildOverseerProfile(accountId: string) {
	const db = getDb();
	const labels = await db
		.selectFrom("message_labels")
		.innerJoin("messages", "messages.id", "message_labels.message_id")
		.select([
			"messages.sender_address",
			"message_labels.label_json",
			"message_labels.primary_bucket",
		])
		.where("messages.account_id", "=", accountId)
		.execute();

	const reviews = await db
		.selectFrom("reviews")
		.innerJoin("messages", "messages.id", "reviews.message_id")
		.innerJoin(
			"classification_results",
			"classification_results.id",
			"reviews.source_classification_result_id",
		)
		.select([
			"reviews.reviewer_note",
			"reviews.override_label_json",
			"messages.sender_address",
			"messages.subject",
			"classification_results.result_json as source_result_json",
		])
		.where("messages.account_id", "=", accountId)
		.where("reviews.status", "=", "resolved")
		.orderBy("reviews.resolved_at", "desc")
		.limit(40)
		.execute();

	const domainCounts = new Map<string, number>();
	const businessDomainCounts = new Map<string, number>();
	const personalDomainCounts = new Map<string, number>();
	const financePurposeCounts = new Map<string, number>();
	const financialSenders = new Map<string, number>();
	const tagCounts = new Map<string, number>();
	const confidentialityCounts = new Map<string, number>();

	for (const row of labels) {
		const domain = extractDomain(row.sender_address);
		if (domain) {
			domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
		}

		const label = parseCurrentMessageLabel(safeJsonParse(row.label_json, null));
		if (!label || typeof label !== "object") {
			continue;
		}

		if (domain) {
			if (label.people.business || label.routing.primaryBucket === "work") {
				businessDomainCounts.set(
					domain,
					(businessDomainCounts.get(domain) ?? 0) + 1,
				);
			}
			if (
				label.people.personal ||
				label.routing.primaryBucket === "relationships"
			) {
				personalDomainCounts.set(
					domain,
					(personalDomainCounts.get(domain) ?? 0) + 1,
				);
			}
		}

		const purpose = label.finance.signal === "none" ? "" : label.finance.signal;
		if (purpose) {
			financePurposeCounts.set(
				purpose,
				(financePurposeCounts.get(purpose) ?? 0) + 1,
			);
		}

		if (label.finance.relevant && row.sender_address) {
			financialSenders.set(
				row.sender_address,
				(financialSenders.get(row.sender_address) ?? 0) + 1,
			);
		}

		for (const tag of label.routing.tags) {
			tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
		}

		if (label.risk.businessSensitive) {
			confidentialityCounts.set(
				"business_sensitive",
				(confidentialityCounts.get("business_sensitive") ?? 0) + 1,
			);
		}
		if (label.risk.leakRisk) {
			confidentialityCounts.set(
				"leak_risk",
				(confidentialityCounts.get("leak_risk") ?? 0) + 1,
			);
		}
	}

	const prompt = readPrompt("overseer-profile-v1.md");
	const result = await piJson({
		schema: overseerProfileSchema,
		modelId: APP_CONFIG.fallbackModel,
		systemPrompt: prompt,
		userPrompt: `${JSON.stringify(
			{
				accountId,
				builtFromMessages: labels.length,
				topDomains: topValues(
					Array.from(domainCounts.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					20,
				),
				businessDomains: topValues(
					Array.from(businessDomainCounts.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					20,
				),
				personalDomains: topValues(
					Array.from(personalDomainCounts.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					20,
				),
				financialSenders: topValues(
					Array.from(financialSenders.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					20,
				),
				financePurposes: topValues(
					Array.from(financePurposeCounts.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					20,
				),
				stableTags: topValues(
					Array.from(tagCounts.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					20,
				),
				confidentialityPatterns: topValues(
					Array.from(confidentialityCounts.entries()).map(([value, count]) => ({
						value,
						count,
					})),
					10,
				),
				reviewOverrides: reviews.length,
				reviewExamples: buildReviewPromptExamples(reviews),
			},
			null,
			2,
		)}

JSON contract:
${JSON.stringify(overseerProfileJsonSchema, null, 2)}

Return one JSON object only.
- Do not use markdown fences.
- Do not include keys outside the schema.
- Use the aggregate inputs to fill the arrays conservatively.
- Keep promptPreamble concise and classification-focused.`,
	});

	const profile = overseerProfileSchema.parse(result.parsed);

	await db
		.insertInto("overseer_profiles")
		.values({
			id: randomUUID(),
			account_id: accountId,
			built_from_messages: profile.builtFromMessages,
			promoted_tags_json: jsonText(profile.promotedTags),
			prompt_preamble: profile.promptPreamble,
			profile_json: jsonText(profile),
			created_at: nowIso(),
		})
		.execute();

	return profile;
}

export async function loadLatestOverseerContext(accountId: string) {
	const db = getDb();
	const latestProfile = await db
		.selectFrom("overseer_profiles")
		.select(["profile_json", "prompt_preamble", "promoted_tags_json"])
		.where("account_id", "=", accountId)
		.orderBy("created_at", "desc")
		.executeTakeFirst();

	return {
		promptPreamble: latestProfile?.prompt_preamble ?? null,
		promotedTags: safeJsonParse<string[]>(
			latestProfile?.promoted_tags_json ?? null,
			[],
		),
		profile: safeJsonParse<OverseerProfileV1 | null>(
			latestProfile?.profile_json ?? null,
			null,
		),
	};
}

export async function maybeQueueOverseerForAccount(accountId: string) {
	const db = getDb();
	const labelCount = await db
		.selectFrom("message_labels")
		.innerJoin("messages", "messages.id", "message_labels.message_id")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("messages.account_id", "=", accountId)
		.executeTakeFirstOrThrow();

	const latestProfile = await db
		.selectFrom("overseer_profiles")
		.select(["built_from_messages"])
		.where("account_id", "=", accountId)
		.orderBy("created_at", "desc")
		.executeTakeFirst();

	const lastBuilt = latestProfile?.built_from_messages ?? 0;
	if (!latestProfile) {
		return Number(labelCount.count) >= APP_CONFIG.overseerBootstrapMinLabels;
	}
	return (
		Number(labelCount.count) - lastBuilt >= APP_CONFIG.overseerRebuildEvery
	);
}
