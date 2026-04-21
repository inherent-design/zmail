import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

const getModels = vi.fn((backend: string) => {
	if (backend === "openai-codex") {
		return [{ id: "gpt-5.4-mini" }, { id: "gpt-5-mini" }];
	}
	return [{ id: "gpt-5-mini" }];
});

const streamSimple = vi.fn((model: { id: string }) => {
	async function* iterator() {
		yield {
			type: "text_end",
			content: '{"value":"ok"}',
		};
	}

	return {
		[Symbol.asyncIterator]: iterator,
		result: async () => ({
			model: model.id,
			usage: { inputTokens: 1, outputTokens: 1 },
			content: [{ text: '{"value":"ok"}' }],
		}),
	};
});

const refreshOpenAICodexToken = vi.fn(async () => ({
	refresh: "refresh-2",
	access: "access-2",
	expires: Date.now() + 60_000,
}));

vi.mock("@mariozechner/pi-ai", () => ({
	getModels,
	streamSimple,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
	openaiCodexOAuthProvider: {
		getApiKey: (credentials: { access: string }) =>
			`subscription:${credentials.access}`,
	},
	refreshOpenAICodexToken,
}));

describe("pi", () => {
	beforeEach(() => {
		delete process.env.ZMAIL_DEBUG_PI;
		getModels.mockClear();
		streamSimple.mockClear();
		refreshOpenAICodexToken.mockClear();
		getModels.mockImplementation((backend: string) => {
			if (backend === "openai-codex") {
				return [{ id: "gpt-5.4-mini" }, { id: "gpt-5-mini" }];
			}
			return [{ id: "gpt-5-mini" }];
		});
		streamSimple.mockImplementation((model: { id: string }) => {
			async function* iterator() {
				yield {
					type: "text_end",
					content: '{"value":"ok"}',
				};
			}

			return {
				[Symbol.asyncIterator]: iterator,
				result: async () => ({
					model: model.id,
					usage: { inputTokens: 1, outputTokens: 1 },
					content: [{ text: '{"value":"ok"}' }],
				}),
			};
		});
	});

	it("prefers subscription in auto mode when credentials exist", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() + 60_000,
				},
				updatedAt: new Date().toISOString(),
			}),
		);
		process.env.OPENAI_API_KEY = "api-key";

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const status = await pi.getPiStatus();

		expect(status.resolvedBackend).toBe("openai-subscription");
	});

	it("falls back to api when subscription is unavailable", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const resolved = await pi.resolvePiRuntime("auto");

		expect(resolved.backend).toBe("openai-api");
		expect(resolved.apiKey).toBe("api-key");
	});

	it("refreshes expired subscription credentials", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() - 1,
				},
				updatedAt: new Date().toISOString(),
			}),
		);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const resolved = await pi.resolvePiRuntime("openai-subscription");

		expect(refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-1");
		expect(resolved.apiKey).toBe("subscription:access-2");
	});

	it("shares concurrent subscription credential refreshes", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() - 1,
				},
				updatedAt: new Date().toISOString(),
			}),
		);
		let finishRefresh = () => {};
		refreshOpenAICodexToken.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				finishRefresh = resolve;
			});
			return {
				refresh: "refresh-2",
				access: "access-2",
				expires: Date.now() + 120_000,
			};
		});

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const first = pi.resolvePiRuntime("openai-subscription");
		const second = pi.resolvePiRuntime("openai-subscription");

		await vi.waitFor(() =>
			expect(refreshOpenAICodexToken).toHaveBeenCalledTimes(1),
		);
		finishRefresh();
		const [firstRuntime, secondRuntime] = await Promise.all([first, second]);

		expect(firstRuntime.apiKey).toBe("subscription:access-2");
		expect(secondRuntime.apiKey).toBe("subscription:access-2");
		expect(await pi.readSubscriptionRecord()).toMatchObject({
			credentials: {
				refresh: "refresh-2",
				access: "access-2",
			},
		});
	});

	it("clears failed shared subscription refreshes so callers can retry", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() - 1,
				},
				updatedAt: new Date().toISOString(),
			}),
		);
		let rejectRefresh = (_error: unknown) => {};
		refreshOpenAICodexToken.mockImplementationOnce(
			() =>
				new Promise<never>((_resolve, reject) => {
					rejectRefresh = reject;
				}),
		);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const first = pi.resolvePiRuntime("openai-subscription");
		const second = pi.resolvePiRuntime("openai-subscription");

		await vi.waitFor(() =>
			expect(refreshOpenAICodexToken).toHaveBeenCalledTimes(1),
		);
		rejectRefresh(new Error("refresh-down"));
		const results = await Promise.allSettled([first, second]);
		expect(results).toEqual([
			expect.objectContaining({ status: "rejected" }),
			expect.objectContaining({ status: "rejected" }),
		]);

		refreshOpenAICodexToken.mockImplementationOnce(async () => ({
			refresh: "refresh-3",
			access: "access-3",
			expires: Date.now() + 120_000,
		}));
		await expect(
			pi.resolvePiRuntime("openai-subscription"),
		).resolves.toMatchObject({
			apiKey: "subscription:access-3",
		});
		expect(refreshOpenAICodexToken).toHaveBeenCalledTimes(2);
	});

	it("fails clearly when no backend is configured", async () => {
		const runtime = await createTestRuntime();
		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");

		await expect(pi.resolvePiRuntime("auto")).rejects.toThrow(
			"No live inference backend configured",
		);
	});

	it("falls back to the first available model when requested model is missing", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const result = await pi.piJson({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			modelId: "missing-model",
			systemPrompt: "system",
			userPrompt: "user",
		});

		expect(result.modelId).toBe("gpt-5-mini");
		expect(streamSimple).toHaveBeenCalled();
	});

	it("sends multimodal user parts through piJsonParts", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const result = await pi.piJsonParts({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			modelId: "gpt-5-mini",
			systemPrompt: "system",
			userParts: [
				{ type: "text", text: "read image" },
				{
					type: "image",
					data: Buffer.from("image").toString("base64"),
					mimeType: "image/png",
				},
			],
		});

		expect(result.parsed).toEqual({ value: "ok" });
		expect(streamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: "gpt-5-mini" }),
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						content: [
							{ type: "text", text: "read image" },
							expect.objectContaining({ type: "image", mimeType: "image/png" }),
						],
					}),
				],
			}),
			expect.any(Object),
		);
	});

	it("resolves explicit backend preferences and reads stored subscriptions", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() + 60_000,
				},
				updatedAt: new Date().toISOString(),
			}),
		);
		process.env.OPENAI_API_KEY = "api-key";

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const record = await pi.readSubscriptionRecord();
		const subscription = await pi.resolvePiRuntime("openai-subscription");
		const api = await pi.resolvePiRuntime("openai-api");

		expect(record.provider).toBe("openai-subscription");
		expect(subscription.backend).toBe("openai-subscription");
		expect(api.backend).toBe("openai-api");
	});

	it("returns unresolved status when no backend is available", async () => {
		const runtime = await createTestRuntime();
		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const status = await pi.getPiStatus();

		expect(status.resolvedBackend).toBeNull();
	});

	it("logs non-error backend resolution failures as strings", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() - 1,
				},
				updatedAt: new Date().toISOString(),
			}),
		);
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		refreshOpenAICodexToken.mockImplementationOnce((async () => {
			throw "subscription-down";
		}) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(pi.resolvePiRuntime("auto")).rejects.toThrow(
			"No live inference backend configured",
		);
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "pi.backend.unavailable",
					fields: expect.objectContaining({
						error_message: "subscription-down",
					}),
				}),
			]),
		);
	});

	it("uses streamed deltas and falls back to assistant content formats", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";

		streamSimple.mockImplementationOnce(((model: { id: string }) => {
			async function* iterator() {
				yield {
					type: "text_delta",
					delta: '{"value":"',
				};
				yield {
					type: "text_delta",
					delta: 'delta"}',
				};
			}

			return {
				[Symbol.asyncIterator]: iterator,
				result: async () => ({
					model: model.id,
					usage: undefined,
					content: [{ text: '{"value":"ignored"}' }],
				}),
			};
		}) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const deltaResult = await pi.piJson({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			systemPrompt: "system",
			userPrompt: "user",
		});
		expect(deltaResult.parsed.value).toBe("delta");
		expect(deltaResult.usage).toBeNull();

		streamSimple.mockImplementationOnce(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: [{ content: '{"value":"assistant"}' }],
			}),
		})) as never);

		const assistantResult = await pi.piJson({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			systemPrompt: "system",
			userPrompt: "user",
		});
		expect(assistantResult.parsed.value).toBe("assistant");

		streamSimple.mockImplementationOnce(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: [{ text: '{"value":"text"}' }, { unknown: true }],
			}),
		})) as never);

		const textResult = await pi.piJson({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			systemPrompt: "system",
			userPrompt: "user",
		});
		expect(textResult.parsed.value).toBe("text");
	});

	it("retries failing models and backends before surfacing the last error", async () => {
		const runtime = await createTestRuntime();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await mkdir(dirname(config.PI_SUBSCRIPTION_PATH), { recursive: true });
		await writeFile(
			config.PI_SUBSCRIPTION_PATH,
			JSON.stringify({
				version: 1,
				provider: "openai-subscription",
				credentials: {
					refresh: "refresh-1",
					access: "access-1",
					expires: Date.now() + 60_000,
				},
				updatedAt: new Date().toISOString(),
			}),
		);
		process.env.OPENAI_API_KEY = "api-key";

		getModels.mockImplementation((backend: string) => {
			if (backend === "openai-codex") {
				return [{ id: "bad-model" }];
			}
			return [{ id: "gpt-5-mini" }];
		});

		streamSimple
			.mockImplementationOnce((() => {
				throw new Error("subscription failed");
			}) as never)
			.mockImplementationOnce((() => {
				throw new Error("subscription failed");
			}) as never)
			.mockImplementationOnce((() => {
				throw new Error("subscription failed");
			}) as never)
			.mockImplementationOnce((() => {
				throw new Error("subscription failed");
			}) as never)
			.mockImplementationOnce((() => {
				throw new Error("subscription failed");
			}) as never)
			.mockImplementationOnce(((model: { id: string }) => ({
				async *[Symbol.asyncIterator]() {
					yield {
						type: "text_end",
						content: '{"value":"ok"}',
					};
				},
				result: async () => ({
					model: model.id,
					usage: { inputTokens: 1, outputTokens: 1 },
					content: [{ text: '{"value":"ok"}' }],
				}),
			})) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const result = await pi.piJson({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			modelId: "bad-model",
			systemPrompt: "system",
			userPrompt: "user",
		});

		expect(result.backend).toBe("openai-api");
		expect(result.modelId).toBe("gpt-5-mini");
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "pi.backend.resolved",
				}),
				expect.objectContaining({
					type: "info",
					event: "pi.retry",
				}),
				expect.objectContaining({
					type: "complete",
					event: "pi.request.complete",
				}),
			]),
		);
	});

	it("throws when no provider models are exposed", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		getModels.mockReturnValue([]);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(
			pi.piJson({
				schema: (await import("zod")).z.object({
					value: (await import("zod")).z.string(),
				}),
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow("No pi-ai OpenAI models available");
	});

	it("uses the first raw model entry when no preferred id matches", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		getModels.mockReturnValue([{ id: undefined as unknown as string }]);
		streamSimple.mockImplementationOnce(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "text_end",
					content: '{"value":"fallback"}',
				};
			},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: [{ text: '{"value":"fallback"}' }],
			}),
		})) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		const result = await pi.piJson({
			schema: (await import("zod")).z.object({
				value: (await import("zod")).z.string(),
			}),
			systemPrompt: "system",
			userPrompt: "user",
		});

		expect(result.parsed.value).toBe("fallback");
	});

	it("wraps non-error failures from every attempt", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		getModels.mockReturnValue([{ id: "bad-model" }]);
		streamSimple.mockImplementation((() => {
			throw "bad-stream";
		}) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(
			pi.piJson({
				schema: (await import("zod")).z.object({
					value: (await import("zod")).z.string(),
				}),
				modelId: "bad-model",
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow("bad-stream");
	});

	it("treats non-array assistant content as empty text", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		streamSimple.mockImplementation(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: null,
			}),
		})) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(
			pi.piJson({
				schema: (await import("zod")).z.object({
					value: (await import("zod")).z.string(),
				}),
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow("Empty assistant response");
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "pi.empty_response",
				}),
				expect.objectContaining({
					type: "fail",
					event: "pi.request.failed",
				}),
			]),
		);
	});

	it("logs empty responses with array assistant content through structured events", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		streamSimple.mockImplementation(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: [{ ignored: true }],
			}),
		})) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(
			pi.piJson({
				schema: (await import("zod")).z.object({
					value: (await import("zod")).z.string(),
				}),
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow("Empty assistant response");
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "pi.empty_response",
					fields: expect.objectContaining({ streamed_length: 0 }),
				}),
			]),
		);
	});

	it("logs parse failures before surfacing the last parse error", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		streamSimple.mockImplementation(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "text_end",
					content: '{"value":123}',
				};
			},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: [{ text: '{"value":123}' }],
			}),
		})) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(
			pi.piJson({
				schema: {
					parse() {
						throw "bad-parse";
					},
				} as never,
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow("bad-parse");
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "pi.parse_failure",
				}),
			]),
		);
	});

	it("surfaces Error parse failures when no candidate validates", async () => {
		const runtime = await createTestRuntime();
		process.env.OPENAI_API_KEY = "api-key";
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		streamSimple.mockImplementation(((model: { id: string }) => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "text_end",
					content: '{"value":123}',
				};
			},
			result: async () => ({
				model: model.id,
				usage: { inputTokens: 1, outputTokens: 1 },
				content: [{ text: '{"value":123}' }],
			}),
		})) as never);

		const pi = await runtime.importFresh<typeof import("#/lib/pi")>("#/lib/pi");
		await expect(
			pi.piJson({
				schema: (await import("zod")).z.object({
					value: (await import("zod")).z.string(),
				}),
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow();
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "pi.parse_failure",
				}),
				expect.objectContaining({
					type: "fail",
					event: "pi.request.failed",
				}),
			]),
		);
	});
});
