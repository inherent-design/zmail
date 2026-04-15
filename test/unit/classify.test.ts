import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertMessageRow,
	insertSecondaryResultRow,
} from "#/test/helpers/db";
import { fixturePath } from "#/test/helpers/fs";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("classify", () => {
	it("builds attachment summaries and prompts with fallbacks", async () => {
		const runtime = await createTestRuntime();
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);

		expect(classify.buildAttachmentSummary([])).toBe("No attachments");
		expect(
			classify.buildAttachmentSummary([
				{
					filename: null,
					mime_type: null,
				},
			]),
		).toBe("(unnamed) [unknown]");

		const prompt = classify.buildUserPrompt({
			accountLabel: "Primary Gmail",
			sender: "billing@example.com",
			subject: "Receipt",
			receivedAt: "2026-01-01",
			bodyText: "body",
			attachmentsSummary: "No attachments",
			moderationFlag: false,
			moderationScores: [],
			allowedTags: ["receipt"],
			promptPreamble: null,
		});

		expect(prompt).toContain("Top moderation scores: none");
		expect(classify.mergeAllowedTags(["receipt", "custom"])).toContain(
			"custom",
		);
	});

	it("classifies with default tags and persists low-confidence reviews", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: {
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: null,
					purpose: "lunch",
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
					overall: 0.4,
					finance: 0.4,
					social: 0.4,
					risk: 0.4,
				},
				explanation: "Low confidence.",
			},
			rawText: "{}",
			usage: null,
		}));
		vi.doMock("#/lib/pi", () => ({
			piJson,
		}));

		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db);

		const result = await classify.classifyMessageNow({
			messageId,
			accountLabel: "Primary Gmail",
			sender: "billing@example.com",
			subject: "Receipt",
			receivedAt: "2026-01-01",
			bodyText: "body",
			attachmentsSummary: "No attachments",
			moderationFlag: false,
			moderationScores: [],
			promptPreamble: "Known sender.",
		});

		expect(result.label.schemaVersion).toBe("message-label.v2");
		expect(result.label.nsfw).toBe(false);
		expect(piJson).toHaveBeenCalled();

		const reviews = await db.selectFrom("reviews").selectAll().execute();
		expect(reviews).toHaveLength(1);
	});

	it("does not open low-confidence reviews for parse-error messages", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: {
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: null,
					purpose: "receipt",
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
					overall: 0.4,
					finance: 0.4,
					social: 0.4,
					risk: 0.4,
				},
				explanation: "Low confidence.",
			},
			rawText: "{}",
			usage: null,
		}));
		vi.doMock("#/lib/pi", () => ({
			piJson,
		}));

		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			parseStatus: "error",
			bodyExtractionStrategy: "parse_error",
			parseErrorReason: "parser failed",
		});

		await classify.classifyMessageNow({
			messageId,
			accountLabel: "Primary Gmail",
			sender: "billing@example.com",
			subject: "Receipt",
			receivedAt: "2026-01-01",
			bodyText: "",
			attachmentsSummary: "No attachments",
			moderationFlag: false,
			moderationScores: [],
			promptPreamble: null,
		});

		const reviews = await db.selectFrom("reviews").selectAll().execute();
		expect(reviews).toHaveLength(0);
	});

	it("preserves manual labels and resolves overrides", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const messageId = await insertMessageRow(db);
		const manualLabel = JSON.parse(
			await readFile(fixturePath("review", "manual-override.json"), "utf8"),
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
				...manualLabel,
				confidence: {
					overall: 0.4,
					finance: 0.4,
					social: 0.4,
					risk: 0.4,
				},
			},
		});

		const reviewId = (
			await db
				.selectFrom("reviews")
				.select("id")
				.where("message_id", "=", messageId)
				.where("status", "=", "open")
				.executeTakeFirstOrThrow()
		).id;

		await classify.writeManualOverride({
			reviewId,
			messageId,
			note: "Manual",
			label: {
				...manualLabel,
				nsfw: true,
			},
		});

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
				...manualLabel,
				nsfw: false,
			},
		});

		const current = await db
			.selectFrom("message_labels")
			.selectAll()
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();
		const review = await db
			.selectFrom("reviews")
			.selectAll()
			.where("id", "=", reviewId)
			.executeTakeFirstOrThrow();

		expect(current.source).toBe("manual");
		expect(current.nsfw).toBe(1);
		expect(review.status).toBe("resolved");
		expect(review.override_label_json).toContain('"message-label.v2"');
	});

	it("marks finance secondary heads stale when the current root label changes", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const messageId = await insertMessageRow(db, {
			contentSha256: "content-message-1",
		});
		await insertSecondaryResultRow(db, {
			messageId,
			contentSha256: "content-message-1",
			registrySha256: "registry-1",
		});

		await classify.persistClassification({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "classify-email-v2",
			source: "model",
			rawResponse: {},
			usage: null,
			label: {
				schemaVersion: "message-label.v2",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: null,
					purpose: "software",
				},
				people: {
					personal: false,
					private: false,
					business: true,
					networking: false,
					community: false,
					recruiting: false,
				},
				commerce: {
					transactional: true,
					shopping: false,
					subscription: true,
					travel: false,
					legal: false,
				},
				knowledge: {
					course: false,
					resource: true,
					documentation: false,
					newsletter: false,
					research: false,
				},
				assets: {
					license: true,
					credential: false,
					account: true,
					document: false,
				},
				entertainment: {
					gaming: false,
					media: false,
					fandom: false,
				},
				risk: {
					businessSensitive: false,
					leakRisk: false,
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt", "subscription", "resources"],
					tags: ["receipt"],
				},
				confidence: {
					overall: 0.9,
					finance: 0.9,
					people: 0.8,
					commerce: 0.95,
					knowledge: 0.7,
					assets: 0.8,
					entertainment: 0.05,
					risk: 0.9,
				},
				explanation: "Confident.",
			},
		});

		const head = await db
			.selectFrom("message_secondary_heads")
			.select(["status"])
			.where("message_id", "=", messageId)
			.where("classifier_key", "=", "finance_intel")
			.executeTakeFirstOrThrow();

		expect(head.status).toBe("stale");
	});
});
