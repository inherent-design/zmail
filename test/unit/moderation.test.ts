import { describe, expect, it, vi } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("moderation", () => {
	it("builds prompt input and formats top scores", async () => {
		const runtime = await createTestRuntime();
		const moderation =
			await runtime.importFresh<typeof import("#/lib/moderation")>(
				"#/lib/moderation",
			);

		expect(
			moderation.buildModerationInput({
				sender: "billing@example.com",
				subject: "Receipt",
				bodyText: "body",
			}),
		).toContain("Sender: billing@example.com");
		expect(
			moderation.topModerationScores({
				low: 0.1,
				high: 0.9,
				mid: 0.4,
			}),
		).toEqual(["high:0.900", "mid:0.400", "low:0.100"]);
	});

	it("persists live moderation results and reuses existing rows", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db);
		const moderation =
			await runtime.importFresh<typeof import("#/lib/moderation")>(
				"#/lib/moderation",
			);

		await moderation.persistModerationResult({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			moderation: {
				schemaVersion: "message-moderation.v1",
				nsfw: false,
				categories: {
					explicitSexual: false,
					suggestiveSexual: false,
					nudity: false,
					sexualMinors: false,
					adultCommercial: false,
				},
				scores: {
					explicitSexual: 0.1,
					suggestiveSexual: 0.2,
					nudity: 0.1,
					sexualMinors: 0,
					adultCommercial: 0.1,
					overall: 0.2,
				},
				explanation: "safe",
			},
			rawResponse: {},
			usage: null,
		});

		const existing = await moderation.ensureModerationForMessage({
			jobId: null,
			messageId,
			sender: "billing@example.com",
			subject: "Receipt",
			bodyText: "body",
		});

		expect(existing.nsfwFlag).toBe(false);
		expect(existing.scores.suggestiveSexual).toBe(0.2);
	});

	it("moderates live when no row exists and derives nsfw from threshold", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db);
		const piJson = vi.fn(async () => ({
			backend: "openai-api",
			modelId: "gpt-5.4-mini",
			parsed: {
				schemaVersion: "message-moderation.v1",
				nsfw: false,
				categories: {
					explicitSexual: false,
					suggestiveSexual: false,
					nudity: true,
					sexualMinors: false,
					adultCommercial: false,
				},
				scores: {
					explicitSexual: 0.1,
					suggestiveSexual: 0.1,
					nudity: 0.7,
					sexualMinors: 0,
					adultCommercial: 0.1,
					overall: 0.7,
				},
				explanation: "unsafe",
			},
			rawText: "{}",
			usage: null,
		}));
		vi.doMock("#/lib/pi", () => ({
			piJson,
		}));

		const moderation =
			await runtime.importFresh<typeof import("#/lib/moderation")>(
				"#/lib/moderation",
			);
		const result = await moderation.ensureModerationForMessage({
			jobId: null,
			messageId,
			sender: "billing@example.com",
			subject: "Receipt",
			bodyText: "body",
		});

		expect(result.nsfwFlag).toBe(true);
		expect(piJson).toHaveBeenCalled();
		const row = await db
			.selectFrom("moderation_results")
			.selectAll()
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();
		expect(row.nsfw_flag).toBe(1);
	});
});
