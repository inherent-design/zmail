import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import {
	APP_CONFIG,
	CLASSIFY_PROMPT_VERSION,
	nowIso,
	PROMPTS_DIR,
} from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { normalizeClassifierVisibleAttachments } from "#/lib/normalize";
import { piJson } from "#/lib/pi";
import { readPromptIdentity } from "#/lib/prompt-identity";
import { publishActionEvent } from "#/lib/runtime-events";
import {
	type MessageLabelV3,
	messageLabelNoNsfwJsonSchema,
	messageLabelWithoutNsfwSchema,
	parseCurrentMessageLabel,
	rootPrimaryBucketSchema,
	rootSecondaryBucketSchema,
} from "#/lib/schemas";
import { markSecondaryHeadStale } from "#/lib/secondary";

function loadBaseTags() {
	try {
		return JSON.parse(
			readFileSync(resolve(PROMPTS_DIR, "tags-v2.json"), "utf8"),
		) as string[];
	} catch {
		return JSON.parse(
			readFileSync(resolve(PROMPTS_DIR, "tags-v1.json"), "utf8"),
		) as string[];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, max = 240): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

function uniqueStringValues(value: unknown, maxItems = 8) {
	if (!Array.isArray(value)) {
		return [];
	}
	return Array.from(
		new Set(
			value
				.map((item) => stringValue(item))
				.filter((item): item is string => item !== null),
		),
	).slice(0, maxItems);
}

const SECONDARY_BUCKET_ALIASES: Record<string, string | null> = {
	account: null,
	accounts: null,
	asset: null,
	assets: null,
	bank: "banking",
	bank_alert: "banking",
	billing: "invoice",
	billing_notice: "invoice",
	business: null,
	course: "courses",
	doc: "documentation",
	docs: "documentation",
	document: "documentation",
	documents: "documentation",
	donation_receipt: "donation",
	finance: null,
	finance_promotion: "promotion",
	investment: null,
	investment_update: null,
	other: null,
	other_finance: null,
	relationship: null,
	relationships: null,
	resource: "resources",
	subscription_billing: "subscription",
	system: null,
	tax_document: "tax",
	tax_notice: "tax",
	transfer: null,
	transfer_confirmation: "banking",
	work: null,
};

const FINANCE_INTEL_REQUIRED_SIGNALS = new Set([
	"receipt",
	"invoice",
	"statement",
	"banking",
	"tax",
	"payroll",
	"investment",
	"donation",
	"transfer",
]);

function normalizePrimaryBucket(value: unknown) {
	const raw = stringValue(value, 80);
	const parsed = rootPrimaryBucketSchema.safeParse(raw);
	return parsed.success ? parsed.data : "other";
}

function normalizeSecondaryBuckets(value: unknown) {
	return uniqueStringValues(value).flatMap((bucket) => {
		const alias = SECONDARY_BUCKET_ALIASES[bucket] ?? bucket;
		if (!alias) {
			return [];
		}
		const parsed = rootSecondaryBucketSchema.safeParse(alias);
		return parsed.success ? [parsed.data] : [];
	});
}

function normalizeFinanceGate(value: unknown) {
	if (!isRecord(value)) {
		return value;
	}
	if (
		value.relevant === true &&
		typeof value.signal === "string" &&
		FINANCE_INTEL_REQUIRED_SIGNALS.has(value.signal)
	) {
		return {
			...value,
			operational: true,
			requiresFinanceIntel: true,
		};
	}
	return value;
}

export function normalizeMessageLabelV3ModelOutput(raw: unknown): unknown {
	if (!isRecord(raw)) {
		return raw;
	}
	const routing = isRecord(raw.routing) ? raw.routing : null;
	return {
		...raw,
		finance: normalizeFinanceGate(raw.finance),
		...(routing
			? {
					routing: {
						...routing,
						primaryBucket: normalizePrimaryBucket(routing.primaryBucket),
						secondaryBuckets: normalizeSecondaryBuckets(
							routing.secondaryBuckets,
						),
						tags: uniqueStringValues(routing.tags),
					},
				}
			: {}),
	};
}

export function buildAttachmentSummary(
	attachments: Array<{ filename: string | null; mime_type: string | null }>,
) {
	if (attachments.length === 0) {
		return "No attachments";
	}
	return normalizeClassifierVisibleAttachments(attachments)
		.map(
			(attachment) =>
				`${attachment.filename ?? "(unnamed)"} [${attachment.mime_type ?? "unknown"}]`,
		)
		.join(", ");
}

export function mergeAllowedTags(promotedTags: string[] = []) {
	return Array.from(new Set([...loadBaseTags(), ...promotedTags])).sort();
}

function extractDomain(address: string | null) {
	if (!address || !address.includes("@")) {
		return null;
	}
	const parts = address.toLowerCase().split("@");
	return parts[parts.length - 1] ?? null;
}

export function summarizeMessageLabelForPrompt(input: unknown) {
	const label = parseCurrentMessageLabel(input);
	if (!label) {
		return null;
	}
	return {
		primaryBucket: label.routing.primaryBucket,
		secondaryBuckets: label.routing.secondaryBuckets,
		tags: label.routing.tags.slice(0, 8),
		finance: {
			relevant: label.finance.relevant,
			signal: label.finance.signal,
			requiresFinanceIntel: label.finance.requiresFinanceIntel,
			bookHint: label.finance.bookHint,
		},
		people: {
			personal: label.people.personal,
			private: label.people.private,
			business: label.people.business,
			networking: label.people.networking,
			community: label.people.community,
			recruiting: label.people.recruiting,
		},
		risk: {
			businessSensitive: label.risk.businessSensitive,
			leakRisk: label.risk.leakRisk,
		},
		explanation: label.explanation,
	};
}

export interface RootReviewExample {
	sender: string | null;
	subject: string | null;
	decision: "accepted" | "overridden";
	reviewerNote: string | null;
	before: ReturnType<typeof summarizeMessageLabelForPrompt>;
	after: ReturnType<typeof summarizeMessageLabelForPrompt>;
}

export async function loadRootReviewExamples(input: {
	accountId: string;
	sender: string | null;
	limit?: number;
}): Promise<RootReviewExample[]> {
	const sender = input.sender?.trim().toLowerCase() || null;
	const domain = extractDomain(sender);
	const limit = input.limit ?? 6;
	const db = getDb();

	async function loadRows(kind: "sender" | "domain") {
		let query = db
			.selectFrom("reviews")
			.innerJoin("messages", "messages.id", "reviews.message_id")
			.innerJoin(
				"classification_results",
				"classification_results.id",
				"reviews.source_classification_result_id",
			)
			.select([
				"reviews.id as review_id",
				"reviews.reviewer_note",
				"reviews.override_label_json",
				"messages.sender_address",
				"messages.subject",
				"classification_results.result_json as source_result_json",
			])
			.where("reviews.status", "=", "resolved")
			.where("messages.account_id", "=", input.accountId);

		if (kind === "sender") {
			if (!sender) {
				return [];
			}
			query = query.where("messages.sender_address", "=", sender);
		} else {
			if (!domain) {
				return [];
			}
			query = query.where("messages.sender_address", "like", `%@${domain}`);
		}

		return query
			.orderBy("reviews.resolved_at", "desc")
			.limit(limit * 2)
			.execute();
	}

	const rows = [...(await loadRows("sender")), ...(await loadRows("domain"))];
	const seen = new Set<string>();
	const examples: RootReviewExample[] = [];
	for (const row of rows) {
		if (seen.has(row.review_id)) {
			continue;
		}
		seen.add(row.review_id);
		const before = summarizeMessageLabelForPrompt(
			safeJsonParse(row.source_result_json, null),
		);
		const override = row.override_label_json
			? summarizeMessageLabelForPrompt(
					safeJsonParse(row.override_label_json, null),
				)
			: null;
		examples.push({
			sender: row.sender_address,
			subject: row.subject,
			decision: override ? "overridden" : "accepted",
			reviewerNote: row.reviewer_note,
			before,
			after: override ?? before,
		});
		if (examples.length >= limit) {
			break;
		}
	}
	return examples;
}

export function buildUserPrompt(input: {
	accountLabel: string;
	sender: string;
	subject: string;
	receivedAt: string;
	bodyText: string;
	attachmentsSummary: string;
	moderationFlag: boolean;
	moderationScores: string[];
	allowedTags: string[];
	promptPreamble: string | null;
	reviewExamples?: RootReviewExample[];
}) {
	const preamble = input.promptPreamble?.trim()
		? `Known account profile:\n${input.promptPreamble.trim()}\n\n`
		: "";
	const examples =
		input.reviewExamples && input.reviewExamples.length > 0
			? [
					"",
					"Resolved review examples for this sender or domain:",
					JSON.stringify(input.reviewExamples, null, 2),
				]
			: [];

	return [
		preamble,
		`Allowed tags: ${input.allowedTags.join(", ")}`,
		`Account: ${input.accountLabel}`,
		`Sender: ${input.sender}`,
		`Subject: ${input.subject}`,
		`Received: ${input.receivedAt}`,
		`NSFW moderation flag: ${input.moderationFlag}`,
		`Top moderation scores: ${input.moderationScores.join(", ") || "none"}`,
		`Attachments: ${input.attachmentsSummary}`,
		...examples,
		"",
		"Normalized body:",
		input.bodyText,
	].join("\n");
}

export async function persistClassification(input: {
	jobId: string | null;
	messageId: string;
	model: string;
	backend: string;
	promptVersion: string;
	promptSha256?: string | null;
	source: string;
	rawResponse: unknown;
	usage: unknown;
	label: MessageLabelV3;
}) {
	const db = getDb();
	const classificationId = randomUUID();
	const lowConfidence =
		input.label.confidence.overall < APP_CONFIG.lowConfidenceThreshold;
	const message = await db
		.selectFrom("messages")
		.select(["content_sha256", "parse_status"])
		.where("id", "=", input.messageId)
		.executeTakeFirstOrThrow();
	const inputContentSha256 = message.content_sha256;

	await db
		.insertInto("classification_results")
		.values({
			id: classificationId,
			job_id: input.jobId,
			message_id: input.messageId,
			schema_version: input.label.schemaVersion,
			model: input.model,
			prompt_version: input.promptVersion,
			prompt_sha256: input.promptSha256 ?? null,
			source: input.source,
			result_json: jsonText(input.label),
			raw_response_json: jsonText({
				backend: input.backend,
				rawResponse: input.rawResponse,
			}),
			usage_json: input.usage ? jsonText(input.usage) : null,
			low_confidence: lowConfidence ? 1 : 0,
			input_content_sha256: inputContentSha256,
			created_at: nowIso(),
		})
		.execute();

	const currentLabel = await db
		.selectFrom("message_labels")
		.select(["source"])
		.where("message_id", "=", input.messageId)
		.executeTakeFirst();

	const manualWins =
		currentLabel?.source === "manual" && input.source === "model";
	if (!manualWins) {
		await db
			.insertInto("message_labels")
			.values({
				message_id: input.messageId,
				classification_result_id: classificationId,
				schema_version: input.label.schemaVersion,
				source: input.source,
				label_json: jsonText(input.label),
				primary_bucket: input.label.routing.primaryBucket,
				low_confidence: lowConfidence ? 1 : 0,
				nsfw: input.label.nsfw ? 1 : 0,
				content_sha256: inputContentSha256,
				updated_at: nowIso(),
			})
			.onConflict((oc) =>
				oc.column("message_id").doUpdateSet({
					classification_result_id: classificationId,
					schema_version: input.label.schemaVersion,
					source: input.source,
					label_json: jsonText(input.label),
					primary_bucket: input.label.routing.primaryBucket,
					low_confidence: lowConfidence ? 1 : 0,
					nsfw: input.label.nsfw ? 1 : 0,
					content_sha256: inputContentSha256,
					updated_at: nowIso(),
				}),
			)
			.execute();
		await publishActionEvent({
			topic: `message:${input.messageId}`,
			eventType: "message.label_updated",
			entityKind: "message",
			entityId: input.messageId,
			payload: {
				messageId: input.messageId,
				primaryBucket: input.label.routing.primaryBucket,
				lowConfidence,
				nsfw: input.label.nsfw,
				contentSha256: inputContentSha256,
			},
		});

		await markSecondaryHeadStale({
			messageId: input.messageId,
			classifierKey: "finance_intel",
		});

		const { projectMessageCategoryAssignment } = await import(
			"#/lib/category-rules"
		);
		await projectMessageCategoryAssignment(input.messageId);
	}

	if (
		input.source === "model" &&
		!manualWins &&
		message.parse_status !== "error"
	) {
		const existingOpenReview = await db
			.selectFrom("reviews")
			.select("id")
			.where("message_id", "=", input.messageId)
			.where("status", "=", "open")
			.executeTakeFirst();

		if (lowConfidence) {
			if (existingOpenReview) {
				await db
					.updateTable("reviews")
					.set({
						source_classification_result_id: classificationId,
					})
					.where("id", "=", existingOpenReview.id)
					.execute();
				await publishActionEvent({
					topic: "reviews",
					eventType: "review.updated",
					entityKind: "review",
					entityId: existingOpenReview.id,
					payload: {
						reviewId: existingOpenReview.id,
						messageId: input.messageId,
						status: "open",
						sourceClassificationResultId: classificationId,
					},
				});
			} else {
				const reviewId = randomUUID();
				await db
					.insertInto("reviews")
					.values({
						id: reviewId,
						message_id: input.messageId,
						source_classification_result_id: classificationId,
						status: "open",
						reviewer_note: null,
						override_label_json: null,
						created_at: nowIso(),
						resolved_at: null,
					})
					.execute();
				await publishActionEvent({
					topic: "reviews",
					eventType: "review.updated",
					entityKind: "review",
					entityId: reviewId,
					payload: {
						reviewId,
						messageId: input.messageId,
						status: "open",
						sourceClassificationResultId: classificationId,
					},
				});
			}
		} else if (existingOpenReview) {
			await db
				.updateTable("reviews")
				.set({
					status: "resolved",
					reviewer_note: "Resolved by higher-confidence reclassification.",
					resolved_at: nowIso(),
				})
				.where("id", "=", existingOpenReview.id)
				.execute();
			await publishActionEvent({
				topic: "reviews",
				eventType: "review.updated",
				entityKind: "review",
				entityId: existingOpenReview.id,
				payload: {
					reviewId: existingOpenReview.id,
					messageId: input.messageId,
					status: "resolved",
				},
			});
		}
	}

	return classificationId;
}

export async function classifyMessageNow(input: {
	jobId?: string | null;
	accountId: string;
	messageId: string;
	accountLabel: string;
	sender: string;
	subject: string;
	receivedAt: string;
	bodyText: string;
	attachmentsSummary: string;
	moderationFlag: boolean;
	moderationScores: string[];
	promptPreamble: string | null;
	allowedTags?: string[];
}) {
	const prompt = readPromptIdentity("classify-email-v3.md");
	const reviewExamples = await loadRootReviewExamples({
		accountId: input.accountId,
		sender: input.sender,
		limit: 6,
	});
	const modelOutputSchema = z.preprocess(
		normalizeMessageLabelV3ModelOutput,
		messageLabelWithoutNsfwSchema,
	);
	const result = await piJson({
		schema: modelOutputSchema,
		systemPrompt: prompt.text,
		userPrompt: `${buildUserPrompt({
			...input,
			allowedTags: input.allowedTags ?? mergeAllowedTags(),
			reviewExamples,
		})}

JSON contract:
${JSON.stringify(messageLabelNoNsfwJsonSchema, null, 2)}

Return one JSON object only.
- Do not use markdown fences.
- Do not omit required keys.
- Do not rename keys.
- Keep confidence as an object with overall, finance, people, commerce, knowledge, assets, entertainment, and risk scores.
- Keep routing as an object with primaryBucket, secondaryBuckets, and tags.`,
	});

	const parsed = messageLabelWithoutNsfwSchema.parse(
		normalizeMessageLabelV3ModelOutput(result.parsed),
	);
	const label = parseCurrentMessageLabel({
		...parsed,
		schemaVersion: "message-label.v3",
		nsfw: input.moderationFlag,
	});
	if (!label) {
		throw new Error("Classifier returned an invalid message-label.v3 payload");
	}

	await persistClassification({
		jobId: input.jobId ?? null,
		messageId: input.messageId,
		model: result.modelId,
		backend: result.backend,
		promptVersion: CLASSIFY_PROMPT_VERSION,
		promptSha256: prompt.sha256,
		source: "model",
		rawResponse: { assistantText: result.rawText },
		usage: result.usage,
		label,
	});

	return {
		backend: result.backend,
		label,
		model: result.modelId,
		usage: result.usage,
	};
}

export async function writeManualOverride(input: {
	reviewId: string;
	messageId: string;
	note: string | null;
	label: unknown;
}) {
	const db = getDb();
	const label = normalizeManualOverrideLabel(input.label);
	const classificationId = randomUUID();
	const message = await db
		.selectFrom("messages")
		.select(["content_sha256"])
		.where("id", "=", input.messageId)
		.executeTakeFirstOrThrow();
	const inputContentSha256 = message.content_sha256;
	await db
		.insertInto("classification_results")
		.values({
			id: classificationId,
			job_id: null,
			message_id: input.messageId,
			schema_version: label.schemaVersion,
			model: "manual",
			prompt_version: CLASSIFY_PROMPT_VERSION,
			prompt_sha256: null,
			source: "manual",
			result_json: jsonText(label),
			raw_response_json: jsonText({ reviewId: input.reviewId }),
			usage_json: null,
			low_confidence: 0,
			input_content_sha256: inputContentSha256,
			created_at: nowIso(),
		})
		.execute();

	await db
		.insertInto("message_labels")
		.values({
			message_id: input.messageId,
			classification_result_id: classificationId,
			schema_version: label.schemaVersion,
			source: "manual",
			label_json: jsonText(label),
			primary_bucket: label.routing.primaryBucket,
			low_confidence: 0,
			nsfw: label.nsfw ? 1 : 0,
			content_sha256: inputContentSha256,
			updated_at: nowIso(),
		})
		.onConflict((oc) =>
			oc.column("message_id").doUpdateSet({
				classification_result_id: classificationId,
				schema_version: label.schemaVersion,
				source: "manual",
				label_json: jsonText(label),
				primary_bucket: label.routing.primaryBucket,
				low_confidence: 0,
				nsfw: label.nsfw ? 1 : 0,
				content_sha256: inputContentSha256,
				updated_at: nowIso(),
			}),
		)
		.execute();
	await publishActionEvent({
		topic: `message:${input.messageId}`,
		eventType: "message.label_updated",
		entityKind: "message",
		entityId: input.messageId,
		payload: {
			messageId: input.messageId,
			primaryBucket: label.routing.primaryBucket,
			lowConfidence: false,
			nsfw: label.nsfw,
			contentSha256: inputContentSha256,
			source: "manual",
		},
	});

	await markSecondaryHeadStale({
		messageId: input.messageId,
		classifierKey: "finance_intel",
	});

	const { projectMessageCategoryAssignment } = await import(
		"#/lib/category-rules"
	);
	await projectMessageCategoryAssignment(input.messageId);

	await db
		.updateTable("reviews")
		.set({
			status: "resolved",
			reviewer_note: input.note,
			override_label_json: jsonText(label),
			resolved_at: nowIso(),
		})
		.where("id", "=", input.reviewId)
		.execute();
	await publishActionEvent({
		topic: "reviews",
		eventType: "review.updated",
		entityKind: "review",
		entityId: input.reviewId,
		payload: {
			reviewId: input.reviewId,
			messageId: input.messageId,
			status: "resolved",
			override: true,
		},
	});

	return classificationId;
}

export function normalizeManualOverrideLabel(input: unknown) {
	const normalized = parseCurrentMessageLabel(input);
	if (!normalized) {
		throw new Error("Override must match message-label.v3.");
	}
	return normalized;
}
