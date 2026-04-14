import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	APP_CONFIG,
	MODERATION_PROMPT_VERSION,
	nowIso,
	PROMPTS_DIR,
} from "#/lib/config";
import { getDb, jsonText } from "#/lib/db";
import { piJson } from "#/lib/pi";
import {
	type MessageModerationV1,
	messageModerationSchema,
} from "#/lib/schemas";

function readPrompt(name: string) {
	return readFileSync(resolve(PROMPTS_DIR, name), "utf8");
}

export function buildModerationInput(message: {
	subject: string;
	sender: string;
	bodyText: string;
}) {
	return [
		`Sender: ${message.sender}`,
		`Subject: ${message.subject}`,
		"",
		"Normalized body:",
		message.bodyText,
	].join("\n");
}

export function buildNsfwFlag(result: MessageModerationV1) {
	const highRiskScores = [
		result.scores.explicitSexual,
		result.scores.nudity,
		result.scores.sexualMinors,
		result.scores.adultCommercial,
	];
	return (
		result.nsfw ||
		highRiskScores.some((value) => value >= APP_CONFIG.nsfwThreshold)
	);
}

export function topModerationScores(scores: Record<string, number>) {
	return Object.entries(scores)
		.sort((left, right) => right[1] - left[1])
		.slice(0, 4)
		.map(([key, value]) => `${key}:${value.toFixed(3)}`);
}

export async function moderateMessageNow(input: {
	messageId: string;
	sender: string;
	subject: string;
	bodyText: string;
}) {
	const prompt = readPrompt("moderate-email-v1.md");
	const result = await piJson({
		schema: messageModerationSchema,
		modelId: APP_CONFIG.moderationModel,
		systemPrompt: prompt,
		userPrompt: `${buildModerationInput(input)}\n\nReturn JSON only.`,
	});

	return {
		backend: result.backend,
		model: result.modelId,
		moderation: result.parsed,
		rawText: result.rawText,
		usage: result.usage,
	};
}

export async function persistModerationResult(input: {
	jobId: string | null;
	messageId: string;
	model: string;
	backend: string;
	moderation: MessageModerationV1;
	rawResponse: unknown;
	usage: unknown;
}) {
	const db = getDb();
	const nsfwFlag = buildNsfwFlag(input.moderation);

	await db
		.insertInto("moderation_results")
		.values({
			id: randomUUID(),
			job_id: input.jobId,
			message_id: input.messageId,
			model: input.model,
			categories_json: jsonText(input.moderation.categories),
			category_scores_json: jsonText(input.moderation.scores),
			raw_response_json: jsonText({
				backend: input.backend,
				promptVersion: MODERATION_PROMPT_VERSION,
				rawResponse: input.rawResponse,
				usage: input.usage,
			}),
			nsfw_flag: nsfwFlag ? 1 : 0,
			created_at: nowIso(),
		})
		.onConflict((oc) =>
			oc.column("message_id").doUpdateSet({
				job_id: input.jobId,
				model: input.model,
				categories_json: jsonText(input.moderation.categories),
				category_scores_json: jsonText(input.moderation.scores),
				raw_response_json: jsonText({
					backend: input.backend,
					promptVersion: MODERATION_PROMPT_VERSION,
					rawResponse: input.rawResponse,
					usage: input.usage,
				}),
				nsfw_flag: nsfwFlag ? 1 : 0,
				created_at: nowIso(),
			}),
		)
		.execute();

	return input.moderation;
}

export async function ensureModerationForMessage(input: {
	jobId: string | null;
	messageId: string;
	sender: string;
	subject: string;
	bodyText: string;
}) {
	const db = getDb();
	const existing = await db
		.selectFrom("moderation_results")
		.select(["nsfw_flag", "category_scores_json"])
		.where("message_id", "=", input.messageId)
		.executeTakeFirst();

	if (existing) {
		return {
			nsfwFlag: Boolean(existing.nsfw_flag),
			scores: JSON.parse(existing.category_scores_json) as Record<
				string,
				number
			>,
		};
	}

	const result = await moderateMessageNow({
		messageId: input.messageId,
		sender: input.sender,
		subject: input.subject,
		bodyText: input.bodyText,
	});

	await persistModerationResult({
		jobId: input.jobId,
		messageId: input.messageId,
		model: result.model,
		backend: result.backend,
		moderation: result.moderation,
		rawResponse: { assistantText: result.rawText },
		usage: result.usage,
	});

	return {
		nsfwFlag: buildNsfwFlag(result.moderation),
		scores: result.moderation.scores,
	};
}
