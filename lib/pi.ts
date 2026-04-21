import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getModels, streamSimple } from "@mariozechner/pi-ai";
import {
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "@mariozechner/pi-ai/oauth";
import type { z } from "zod";

import {
	APP_CONFIG,
	PI_SUBSCRIPTION_PATH,
	requireOpenAiApiKey,
} from "#/lib/config";
import { type LogTrace, startTrace } from "#/lib/log";

export type PiBackendPreference = "auto" | "openai-api" | "openai-subscription";

export type PiBackendKind = "openai-api" | "openai-subscription";

export interface PiRuntime {
	backend: PiBackendKind;
	providerBackend: "openai" | "openai-codex";
	apiKey: string;
}

interface SubscriptionRecord {
	version: 1;
	provider: "openai-subscription";
	credentials: {
		refresh: string;
		access: string;
		expires: number;
	};
	updatedAt: string;
}

function extractAssistantText(message: AssistantMessage) {
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.flatMap((entry) => {
			if ("text" in entry && typeof entry.text === "string") {
				return [entry.text];
			}
			if ("content" in entry && typeof entry.content === "string") {
				return [entry.content];
			}
			return [];
		})
		.join("\n")
		.trim();
}

function normalizeJsonText(value: string) {
	return value
		.trim()
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
}

function modelCandidates(
	providerBackend: "openai" | "openai-codex",
	requestedModelId?: string,
) {
	const models = getModels(providerBackend);
	if (models.length === 0) {
		throw new Error("No pi-ai OpenAI models available");
	}

	const preferredIds = Array.from(
		new Set([
			requestedModelId,
			APP_CONFIG.fallbackModel,
			APP_CONFIG.classifierModel,
			models[0]?.id,
		]),
	).filter((value): value is string => Boolean(value));

	const resolved = preferredIds
		.map((modelId) => models.find((candidate) => candidate.id === modelId))
		.filter((candidate): candidate is (typeof models)[number] =>
			Boolean(candidate),
		);

	if (resolved.length > 0) {
		return resolved;
	}

	return [models[0]];
}

export async function readSubscriptionRecord() {
	const text = await readFile(PI_SUBSCRIPTION_PATH, "utf8");
	return JSON.parse(text) as SubscriptionRecord;
}

export async function writeSubscriptionRecord(record: SubscriptionRecord) {
	await writeFile(
		PI_SUBSCRIPTION_PATH,
		JSON.stringify(record, null, 2),
		"utf8",
	);
}

function backendOrder(
	preference: PiBackendPreference = APP_CONFIG.piBackend as PiBackendPreference,
) {
	if (preference === "openai-api") {
		return ["openai-api"] as const;
	}
	if (preference === "openai-subscription") {
		return ["openai-subscription"] as const;
	}
	return ["openai-subscription", "openai-api"] as const;
}

async function resolveRuntimeForBackend(
	backend: PiBackendKind,
	trace?: LogTrace,
): Promise<PiRuntime> {
	if (backend === "openai-api") {
		trace?.complete("pi.backend.resolved", {
			backend,
			provider_backend: "openai",
		});
		return {
			backend,
			providerBackend: "openai",
			apiKey: requireOpenAiApiKey(),
		};
	}

	const record = await readSubscriptionRecord();
	let credentials = record.credentials;
	if (credentials.expires <= Date.now() + 60_000) {
		trace?.info("pi.subscription.refreshing", {
			backend,
		});
		credentials = await refreshOpenAICodexToken(credentials.refresh);
		await writeSubscriptionRecord({
			...record,
			credentials,
			updatedAt: new Date().toISOString(),
		});
	}

	trace?.complete("pi.backend.resolved", {
		backend,
		provider_backend: "openai-codex",
	});
	return {
		backend,
		providerBackend: "openai-codex",
		apiKey: openaiCodexOAuthProvider.getApiKey(credentials),
	};
}

export async function resolvePiRuntime(
	preference: PiBackendPreference = APP_CONFIG.piBackend as PiBackendPreference,
) {
	const trace = startTrace({
		kind: "pi",
		operation: "resolve_runtime",
	});
	for (const backend of backendOrder(preference)) {
		try {
			const runtime = await resolveRuntimeForBackend(
				backend,
				trace.child({
					kind: "pi",
					operation: "resolve_runtime_backend",
					backend,
				}),
			);
			trace.complete("pi.runtime.resolved", {
				backend: runtime.backend,
				provider_backend: runtime.providerBackend,
			});
			return runtime;
		} catch (error) {
			trace.info("pi.backend.unavailable", {
				outcome: "backend_unavailable",
				backend,
				error_message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const finalError = new Error(
		"No live inference backend configured. Run pnpm pi:connect or set OPENAI_API_KEY.",
	);
	trace.fail("pi.runtime.resolve_failed", finalError);
	throw finalError;
}

export async function getPiStatus() {
	const subscriptionConfigured = existsSync(PI_SUBSCRIPTION_PATH);
	const apiConfigured = Boolean(process.env.OPENAI_API_KEY);
	const preferredBackend = APP_CONFIG.piBackend as PiBackendPreference;
	let resolvedBackend: PiBackendKind | null = null;

	try {
		const runtime = await resolvePiRuntime(preferredBackend);
		resolvedBackend = runtime.backend;
	} catch {
		resolvedBackend = null;
	}

	return {
		subscriptionConfigured,
		apiConfigured,
		preferredBackend,
		resolvedBackend,
	};
}

export type PiUserPart =
	| { type: "text"; text: string }
	| {
			type: "image";
			data: string;
			mimeType: "image/png" | "image/jpeg" | "image/webp";
	  };

export async function piJson<T>(input: {
	schema: z.ZodType<T>;
	modelId?: string;
	systemPrompt: string;
	userPrompt: string;
}) {
	const trace = startTrace({
		kind: "pi",
		operation: "pi_json",
		requested_model: input.modelId ?? APP_CONFIG.classifierModel,
	});
	trace.info("pi.request.start");
	let lastError: unknown = null;
	for (const backend of backendOrder()) {
		try {
			const runtime = await resolveRuntimeForBackend(
				backend,
				trace.child({
					kind: "pi",
					operation: "resolve_backend",
					backend,
				}),
			);
			trace.info("pi.request.backend_selected", {
				backend: runtime.backend,
				provider_backend: runtime.providerBackend,
			});
			for (const model of modelCandidates(
				runtime.providerBackend,
				input.modelId ?? APP_CONFIG.classifierModel,
			)) {
				for (let attempt = 0; attempt < 5; attempt += 1) {
					try {
						const stream = streamSimple(
							model,
							{
								systemPrompt: input.systemPrompt,
								messages: [
									{
										role: "user",
										content: input.userPrompt,
										timestamp: Date.now(),
									},
								],
							},
							{
								apiKey: runtime.apiKey,
								transport: "sse",
							},
						);

						let streamedText = "";
						for await (const event of stream) {
							if (event.type === "text_delta") {
								streamedText += event.delta;
								continue;
							}
							if (event.type === "text_end" && streamedText.length === 0) {
								streamedText += event.content;
							}
						}

						const message = await stream.result();
						const candidates = Array.from(
							new Set(
								[streamedText, extractAssistantText(message)]
									.map((value) => value.trim())
									.filter((value) => value.length > 0),
							),
						);

						if (candidates.length === 0) {
							trace.info("pi.empty_response", {
								outcome: "empty_response",
								backend: runtime.backend,
								model: model.id,
								attempt: attempt + 1,
								streamed_length: streamedText.length,
							});
							throw new Error("Empty assistant response");
						}

						let parsed: T | null = null;
						let assistantText = "";
						let parseError: unknown = null;
						for (const candidate of candidates) {
							try {
								parsed = input.schema.parse(
									JSON.parse(normalizeJsonText(candidate)),
								);
								assistantText = candidate;
								parseError = null;
								break;
							} catch (error) {
								trace.info("pi.parse_failure", {
									outcome: "parse_failure",
									backend: runtime.backend,
									model: model.id,
									attempt: attempt + 1,
									candidate_length: candidate.length,
									error_message:
										error instanceof Error ? error.message : String(error),
								});
								parseError = error;
							}
						}

						if (!parsed) {
							throw parseError instanceof Error
								? parseError
								: new Error(String(parseError));
						}

						trace.complete("pi.request.complete", {
							backend: runtime.backend,
							model: message.model,
						});
						return {
							backend: runtime.backend,
							modelId: message.model,
							parsed,
							rawText: assistantText,
							usage: message.usage ?? null,
						};
					} catch (error) {
						lastError = error;
						trace.info("pi.retry", {
							outcome: "retry",
							backend: runtime.backend,
							model: model.id,
							attempt: attempt + 1,
							error_message:
								error instanceof Error ? error.message : String(error),
						});
						if (attempt < 4) {
							await new Promise((resolveDelay) => {
								setTimeout(resolveDelay, 250);
							});
						}
					}
				}
			}
		} catch (error) {
			lastError = error;
		}
	}

	const finalError =
		lastError instanceof Error ? lastError : new Error(String(lastError));
	trace.fail("pi.request.failed", finalError);
	throw finalError;
}

export async function piJsonParts<T>(input: {
	schema: z.ZodType<T>;
	modelId?: string;
	systemPrompt: string;
	userParts: PiUserPart[];
}) {
	const trace = startTrace({
		kind: "pi",
		operation: "pi_json_parts",
		requested_model: input.modelId ?? APP_CONFIG.classifierModel,
	});
	trace.info("pi.request.start", {
		part_count: input.userParts.length,
		image_count: input.userParts.filter((part) => part.type === "image").length,
	});
	let lastError: unknown = null;
	for (const backend of backendOrder()) {
		try {
			const runtime = await resolveRuntimeForBackend(
				backend,
				trace.child({
					kind: "pi",
					operation: "resolve_backend",
					backend,
				}),
			);
			trace.info("pi.request.backend_selected", {
				backend: runtime.backend,
				provider_backend: runtime.providerBackend,
			});
			for (const model of modelCandidates(
				runtime.providerBackend,
				input.modelId ?? APP_CONFIG.classifierModel,
			)) {
				for (let attempt = 0; attempt < 5; attempt += 1) {
					try {
						const stream = streamSimple(
							model,
							{
								systemPrompt: input.systemPrompt,
								messages: [
									{
										role: "user",
										content: input.userParts,
										timestamp: Date.now(),
									},
								],
							},
							{
								apiKey: runtime.apiKey,
								transport: "sse",
							},
						);

						let streamedText = "";
						for await (const event of stream) {
							if (event.type === "text_delta") {
								streamedText += event.delta;
								continue;
							}
							if (event.type === "text_end" && streamedText.length === 0) {
								streamedText += event.content;
							}
						}

						const message = await stream.result();
						const candidates = Array.from(
							new Set(
								[streamedText, extractAssistantText(message)]
									.map((value) => value.trim())
									.filter((value) => value.length > 0),
							),
						);

						if (candidates.length === 0) {
							trace.info("pi.empty_response", {
								outcome: "empty_response",
								backend: runtime.backend,
								model: model.id,
								attempt: attempt + 1,
								streamed_length: streamedText.length,
							});
							throw new Error("Empty assistant response");
						}

						let parsed: T | null = null;
						let assistantText = "";
						let parseError: unknown = null;
						for (const candidate of candidates) {
							try {
								parsed = input.schema.parse(
									JSON.parse(normalizeJsonText(candidate)),
								);
								assistantText = candidate;
								parseError = null;
								break;
							} catch (error) {
								trace.info("pi.parse_failure", {
									outcome: "parse_failure",
									backend: runtime.backend,
									model: model.id,
									attempt: attempt + 1,
									candidate_length: candidate.length,
									error_message:
										error instanceof Error ? error.message : String(error),
								});
								parseError = error;
							}
						}

						if (!parsed) {
							throw parseError instanceof Error
								? parseError
								: new Error(String(parseError));
						}

						trace.complete("pi.request.complete", {
							backend: runtime.backend,
							model: message.model,
						});
						return {
							backend: runtime.backend,
							modelId: message.model,
							parsed,
							rawText: assistantText,
							usage: message.usage ?? null,
						};
					} catch (error) {
						lastError = error;
						trace.info("pi.retry", {
							outcome: "retry",
							backend: runtime.backend,
							model: model.id,
							attempt: attempt + 1,
							error_message:
								error instanceof Error ? error.message : String(error),
						});
						if (attempt < 4) {
							await new Promise((resolveDelay) => {
								setTimeout(resolveDelay, 250);
							});
						}
					}
				}
			}
		} catch (error) {
			lastError = error;
		}
	}

	const finalError =
		lastError instanceof Error ? lastError : new Error(String(lastError));
	trace.fail("pi.request.failed", finalError);
	throw finalError;
}
