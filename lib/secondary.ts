import { randomUUID } from "node:crypto";

import { APP_CONFIG, nowIso } from "#/lib/config";
import { getDb, jsonText } from "#/lib/db";
import type {
	SecondaryClassifierKey,
	SecondaryHeadStatus,
} from "#/lib/schemas";

export function isLowConfidenceScore(overall: number) {
	return overall < APP_CONFIG.lowConfidenceThreshold;
}

export function resolveSecondaryHeadStatus(input: {
	status?: SecondaryHeadStatus;
	overallConfidence?: number | null;
}) {
	if (input.status) {
		return input.status;
	}
	if (
		typeof input.overallConfidence === "number" &&
		isLowConfidenceScore(input.overallConfidence)
	) {
		return "review" satisfies SecondaryHeadStatus;
	}
	return "ready" satisfies SecondaryHeadStatus;
}

export async function upsertSecondaryHead(input: {
	messageId: string;
	classifierKey: SecondaryClassifierKey;
	secondaryResultId?: string | null;
	status: SecondaryHeadStatus;
	lowConfidence?: boolean;
	contentSha256: string | null;
	registrySha256: string | null;
}) {
	const db = getDb();
	await db
		.insertInto("message_secondary_heads")
		.values({
			message_id: input.messageId,
			classifier_key: input.classifierKey,
			secondary_result_id: input.secondaryResultId ?? null,
			status: input.status,
			low_confidence: input.lowConfidence ? 1 : 0,
			content_sha256: input.contentSha256,
			registry_sha256: input.registrySha256,
			updated_at: nowIso(),
		})
		.onConflict((oc) =>
			oc.columns(["message_id", "classifier_key"]).doUpdateSet({
				secondary_result_id: input.secondaryResultId ?? null,
				status: input.status,
				low_confidence: input.lowConfidence ? 1 : 0,
				content_sha256: input.contentSha256,
				registry_sha256: input.registrySha256,
				updated_at: nowIso(),
			}),
		)
		.execute();
}

export async function markSecondaryHeadStale(input: {
	messageId: string;
	classifierKey: SecondaryClassifierKey;
}) {
	const db = getDb();
	await db
		.updateTable("message_secondary_heads")
		.set({
			status: "stale",
			updated_at: nowIso(),
		})
		.where("message_id", "=", input.messageId)
		.where("classifier_key", "=", input.classifierKey)
		.execute();
}

export async function persistSecondaryResult<TResult>(input: {
	jobId: string | null;
	messageId: string;
	classifierKey: SecondaryClassifierKey;
	schemaVersion: string;
	model: string;
	backend: string;
	promptVersion: string;
	source: string;
	rawResponse: unknown;
	usage: unknown;
	result: TResult;
	contentSha256?: string | null;
	registrySha256?: string | null;
	status?: SecondaryHeadStatus;
	overallConfidence?: number | null;
}) {
	const db = getDb();
	const resultId = randomUUID();
	const message = await db
		.selectFrom("messages")
		.select(["content_sha256"])
		.where("id", "=", input.messageId)
		.executeTakeFirstOrThrow();
	const contentSha256 =
		input.contentSha256 === undefined
			? message.content_sha256
			: input.contentSha256;
	const lowConfidence =
		typeof input.overallConfidence === "number"
			? isLowConfidenceScore(input.overallConfidence)
			: false;
	const status = resolveSecondaryHeadStatus({
		status: input.status,
		overallConfidence: input.overallConfidence,
	});

	await db
		.insertInto("message_secondary_results")
		.values({
			id: resultId,
			message_id: input.messageId,
			classifier_key: input.classifierKey,
			schema_version: input.schemaVersion,
			job_id: input.jobId,
			model: input.model,
			prompt_version: input.promptVersion,
			source: input.source,
			result_json: jsonText(input.result),
			raw_response_json: jsonText({
				backend: input.backend,
				rawResponse: input.rawResponse,
			}),
			usage_json: input.usage ? jsonText(input.usage) : null,
			input_content_sha256: contentSha256,
			input_registry_sha256: input.registrySha256 ?? null,
			created_at: nowIso(),
		})
		.execute();

	await upsertSecondaryHead({
		messageId: input.messageId,
		classifierKey: input.classifierKey,
		secondaryResultId: resultId,
		status,
		lowConfidence,
		contentSha256,
		registrySha256: input.registrySha256 ?? null,
	});

	return {
		lowConfidence,
		resultId,
		status,
	};
}

export function isSecondaryHeadCurrent(
	head:
		| {
				status: string;
				content_sha256: string | null;
				registry_sha256: string | null;
		  }
		| null
		| undefined,
	input: {
		contentSha256: string | null;
		registrySha256: string | null;
	},
) {
	if (!head) {
		return false;
	}
	if (
		head.content_sha256 !== input.contentSha256 ||
		head.registry_sha256 !== input.registrySha256
	) {
		return false;
	}
	return head.status === "ready" || head.status === "review";
}
