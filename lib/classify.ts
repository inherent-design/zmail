import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	APP_CONFIG,
	CLASSIFY_PROMPT_VERSION,
	nowIso,
	PROMPTS_DIR,
} from "#/lib/config";
import { getDb, jsonText } from "#/lib/db";
import { normalizeClassifierVisibleAttachments } from "#/lib/normalize";
import { piJson } from "#/lib/pi";
import {
	type MessageLabelV2,
	messageLabelNoNsfwJsonSchema,
	messageLabelWithoutNsfwSchema,
	messageLabelWithoutNsfwV1Schema,
	normalizeMessageLabel,
} from "#/lib/schemas";
import { markSecondaryHeadStale } from "#/lib/secondary";

function readPrompt(name: string) {
	return readFileSync(resolve(PROMPTS_DIR, name), "utf8");
}

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
}) {
	const preamble = input.promptPreamble?.trim()
		? `Known account profile:\n${input.promptPreamble.trim()}\n\n`
		: "";

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
	source: string;
	rawResponse: unknown;
	usage: unknown;
	label: MessageLabelV2;
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
			} else {
				await db
					.insertInto("reviews")
					.values({
						id: randomUUID(),
						message_id: input.messageId,
						source_classification_result_id: classificationId,
						status: "open",
						reviewer_note: null,
						override_label_json: null,
						created_at: nowIso(),
						resolved_at: null,
					})
					.execute();
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
		}
	}

	return classificationId;
}

export async function classifyMessageNow(input: {
	jobId?: string | null;
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
	const prompt = readPrompt("classify-email-v2.md");
	const result = await piJson({
		schema: messageLabelWithoutNsfwSchema,
		systemPrompt: prompt,
		userPrompt: `${buildUserPrompt({
			...input,
			allowedTags: input.allowedTags ?? mergeAllowedTags(),
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

	const parsedV2 = messageLabelWithoutNsfwSchema.safeParse(result.parsed);
	const label = parsedV2.success
		? normalizeMessageLabel({
				...parsedV2.data,
				schemaVersion: "message-label.v2",
				nsfw: input.moderationFlag,
			})
		: normalizeMessageLabel({
				...messageLabelWithoutNsfwV1Schema.parse(result.parsed),
				schemaVersion: "message-label.v1",
				nsfw: input.moderationFlag,
			});
	if (!label) {
		throw new Error("Classifier returned an invalid message label");
	}

	await persistClassification({
		jobId: input.jobId ?? null,
		messageId: input.messageId,
		model: result.modelId,
		backend: result.backend,
		promptVersion: CLASSIFY_PROMPT_VERSION,
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

	return classificationId;
}

export function normalizeManualOverrideLabel(input: unknown) {
	const normalized = normalizeMessageLabel(input);
	if (!normalized) {
		throw new Error("Override must match message-label.v2.");
	}
	return normalized;
}
