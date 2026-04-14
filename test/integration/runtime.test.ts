import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { fixturePath } from "#/test/helpers/fs";
import { createTestRuntime } from "#/test/helpers/runtime";

function mockPiModule() {
	const piJson = vi.fn(async (input: { userPrompt: string }) => {
		if (input.userPrompt.includes("Allowed tags:")) {
			const lowConfidence = input.userPrompt.includes("low-confidence-case");
			return {
				backend: "openai-subscription",
				modelId: "gpt-5.4-mini",
				parsed: {
					finance: {
						relevant: true,
						direction: "expense",
						owner: "business",
						accountHint: "amex",
						purpose: "client lunch",
					},
					social: {
						personal: false,
						private: false,
						social: false,
						business: true,
					},
					risk: {
						businessSensitive: false,
						leakRisk: false,
					},
					routing: {
						primaryBucket: "finance",
						tags: ["receipt"],
					},
					confidence: {
						overall: lowConfidence ? 0.5 : 0.95,
						finance: 0.9,
						social: 0.9,
						risk: 0.9,
					},
					explanation: "Model classification.",
				},
				rawText: "{}",
				usage: { totalTokens: 10 },
			};
		}

		if (
			input.userPrompt.includes("Sender:") &&
			input.userPrompt.includes("Normalized body:")
		) {
			const unsafe = input.userPrompt.includes("xxx");
			return {
				backend: "openai-subscription",
				modelId: "gpt-5.4-mini",
				parsed: {
					schemaVersion: "message-moderation.v1",
					nsfw: unsafe,
					categories: {
						explicitSexual: unsafe,
						suggestiveSexual: false,
						nudity: unsafe,
						sexualMinors: false,
						adultCommercial: false,
					},
					scores: {
						explicitSexual: unsafe ? 0.7 : 0.1,
						suggestiveSexual: 0.1,
						nudity: unsafe ? 0.61 : 0.1,
						sexualMinors: 0,
						adultCommercial: 0.2,
						overall: unsafe ? 0.7 : 0.1,
					},
					explanation: "Moderation result.",
				},
				rawText: "{}",
				usage: { totalTokens: 8 },
			};
		}

		return {
			backend: "openai-subscription",
			modelId: "gpt-5-mini",
			parsed: {
				schemaVersion: "overseer-profile.v1",
				accountId: "acct-1",
				builtFromMessages: 1,
				knownBusinessDomains: ["billing.example.com"],
				knownPersonalDomains: ["friend.example.org"],
				knownFinancialSenders: ["billing@example.com"],
				recurringPurposeHints: ["client lunch"],
				confidentialityPatterns: ["business_sensitive"],
				promotedTags: ["receipt"],
				promptPreamble: "Known sender: billing@example.com",
			},
			rawText: "{}",
			usage: { totalTokens: 12 },
		};
	});

	vi.doMock("#/lib/pi", () => ({
		piJson,
		getPiStatus: vi.fn(async () => ({
			subscriptionConfigured: true,
			apiConfigured: false,
			preferredBackend: "auto",
			resolvedBackend: "openai-subscription",
		})),
	}));

	return { piJson };
}

describe("runtime integration", () => {
	it("moderates, classifies, creates one review, and preserves manual labels", async () => {
		const runtime = await createTestRuntime();
		mockPiModule();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const lowConfidenceMessageId = await insertMessageRow(db, {
			subject: "low-confidence-case",
			bodyTextNormalized: "expense receipt low-confidence-case",
		});

		const moderation =
			await runtime.importFresh<typeof import("#/lib/moderation")>(
				"#/lib/moderation",
			);
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const manualLabel = JSON.parse(
			await readFile(fixturePath("review", "manual-override.json"), "utf8"),
		);

		const moderationResult = await moderation.ensureModerationForMessage({
			jobId: null,
			messageId: lowConfidenceMessageId,
			sender: "billing@example.com",
			subject: "low-confidence-case",
			bodyText: "expense receipt xxx low-confidence-case",
		});
		expect(moderationResult.nsfwFlag).toBe(true);

		const classified = await classify.classifyMessageNow({
			messageId: lowConfidenceMessageId,
			accountLabel: "Primary Gmail",
			sender: "billing@example.com",
			subject: "low-confidence-case",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "expense receipt low-confidence-case",
			attachmentsSummary: "No attachments",
			moderationFlag: true,
			moderationScores: moderation.topModerationScores(moderationResult.scores),
			promptPreamble: null,
			allowedTags: ["receipt"],
		});
		expect(classified.label.routing.primaryBucket).toBe("finance");
		expect(classified.label.nsfw).toBe(true);

		await classify.classifyMessageNow({
			messageId: lowConfidenceMessageId,
			accountLabel: "Primary Gmail",
			sender: "billing@example.com",
			subject: "low-confidence-case",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "expense receipt low-confidence-case",
			attachmentsSummary: "No attachments",
			moderationFlag: true,
			moderationScores: moderation.topModerationScores(moderationResult.scores),
			promptPreamble: null,
			allowedTags: ["receipt"],
		});

		const reviews = await db.selectFrom("reviews").selectAll().execute();
		expect(reviews).toHaveLength(1);

		await classify.writeManualOverride({
			reviewId: reviews[0].id,
			messageId: lowConfidenceMessageId,
			note: "Reviewed manually",
			label: manualLabel,
		});

		await classify.classifyMessageNow({
			messageId: lowConfidenceMessageId,
			accountLabel: "Primary Gmail",
			sender: "billing@example.com",
			subject: "invoice rerun",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "expense receipt",
			attachmentsSummary: "No attachments",
			moderationFlag: false,
			moderationScores: ["explicitSexual:0.1"],
			promptPreamble: null,
			allowedTags: ["receipt"],
		});

		const currentLabel = await db
			.selectFrom("message_labels")
			.selectAll()
			.where("message_id", "=", lowConfidenceMessageId)
			.executeTakeFirstOrThrow();
		expect(currentLabel.source).toBe("manual");

		const resolvedReview = await db
			.selectFrom("reviews")
			.selectAll()
			.where("id", "=", reviews[0].id)
			.executeTakeFirstOrThrow();
		expect(resolvedReview.status).toBe("resolved");
		expect(resolvedReview.override_label_json).toContain("message-label.v1");
	});

	it("builds overseer profiles and checks rebuild threshold", async () => {
		const runtime = await createTestRuntime();
		mockPiModule();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			senderAddress: "billing@example.com",
			subject: "Receipt",
			bodyTextNormalized: "expense receipt",
		});

		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		await classify.persistClassification({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "classify-email-v1",
			source: "model",
			rawResponse: {},
			usage: null,
			label: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "amex",
					purpose: "client lunch",
				},
				social: {
					personal: false,
					private: false,
					social: false,
					business: true,
				},
				risk: {
					businessSensitive: true,
					leakRisk: false,
				},
				routing: {
					primaryBucket: "finance",
					tags: ["receipt"],
				},
				confidence: {
					overall: 0.9,
					finance: 0.9,
					social: 0.9,
					risk: 0.9,
				},
				explanation: "Seed label.",
			},
		});

		const overseer =
			await runtime.importFresh<typeof import("#/lib/overseer")>(
				"#/lib/overseer",
			);
		const profile = await overseer.buildOverseerProfile("acct-1");
		expect(profile.accountId).toBe("acct-1");

		const context = await overseer.loadLatestOverseerContext("acct-1");
		expect(context.promptPreamble).toContain("Known sender");

		const shouldQueue = await overseer.maybeQueueOverseerForAccount("acct-1");
		expect(shouldQueue).toBe(false);
	});
});
