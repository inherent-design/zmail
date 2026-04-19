import { describe, expect, it, vi } from "vitest";
import {
	type MessageLabelV3,
	messageLabelWithoutNsfwSchema,
} from "#/lib/schemas";
import {
	bootDb,
	insertMessageRow,
	insertSecondaryResultRow,
} from "#/test/helpers/db";
import { buildMessageLabelV3 } from "#/test/helpers/labels";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("classify", () => {
	it("normalizes invalid root secondary bucket aliases from model output", async () => {
		const runtime = await createTestRuntime();
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const raw = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "investment",
				operational: true,
				bookHint: "personal",
				requiresFinanceIntel: true,
				confidence: 0.8,
				evidence: "Brokerage alert.",
			},
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["banking"],
				tags: ["banking"],
			},
		}) as unknown as Record<string, unknown>;
		raw.routing = {
			primaryBucket: "finance",
			secondaryBuckets: [
				"banking",
				"investment",
				"transfer",
				"tax_document",
				"other",
			],
			tags: ["banking", "banking", "investment"],
		};

		const normalized = classify.normalizeMessageLabelV3ModelOutput(raw);
		const parsed = messageLabelWithoutNsfwSchema.parse(normalized);

		expect(parsed.routing.secondaryBuckets).toEqual(["banking", "tax"]);
		expect(parsed.routing.tags).toEqual(["banking", "investment"]);
		expect(parsed.finance.signal).toBe("investment");
	});

	it("normalizes required finance-intel gates for operational signals", async () => {
		const runtime = await createTestRuntime();
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const raw = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "receipt",
				operational: false,
				bookHint: "business",
				requiresFinanceIntel: false,
				confidence: 0.9,
				evidence: "Apple receipt.",
			},
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["receipt"],
				tags: ["receipt"],
			},
		});

		const parsed = messageLabelWithoutNsfwSchema.parse(
			classify.normalizeMessageLabelV3ModelOutput(raw),
		);

		expect(parsed.finance.operational).toBe(true);
		expect(parsed.finance.requiresFinanceIntel).toBe(true);
	});

	it("leaves promotion and subscription finance gates unchanged", async () => {
		const runtime = await createTestRuntime();
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const promotion = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "promotion",
				operational: false,
				bookHint: "unknown",
				requiresFinanceIntel: false,
				confidence: 0.9,
				evidence: "Card offer.",
			},
		});
		const subscription = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "subscription",
				operational: false,
				bookHint: "unknown",
				requiresFinanceIntel: false,
				confidence: 0.9,
				evidence: "Upcoming renewal.",
			},
		});
		const explicitSubscription = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "subscription",
				operational: true,
				bookHint: "business",
				requiresFinanceIntel: true,
				confidence: 0.9,
				evidence: "Paid subscription receipt.",
			},
		});

		expect(
			messageLabelWithoutNsfwSchema.parse(
				classify.normalizeMessageLabelV3ModelOutput(promotion),
			).finance.requiresFinanceIntel,
		).toBe(false);
		expect(
			messageLabelWithoutNsfwSchema.parse(
				classify.normalizeMessageLabelV3ModelOutput(subscription),
			).finance.requiresFinanceIntel,
		).toBe(false);
		expect(
			messageLabelWithoutNsfwSchema.parse(
				classify.normalizeMessageLabelV3ModelOutput(explicitSubscription),
			).finance.requiresFinanceIntel,
		).toBe(true);
	});

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

	it("classifies after sanitizing invalid model secondary buckets", async () => {
		const runtime = await createTestRuntime();
		const parsed = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "investment",
				operational: true,
				bookHint: "personal",
				requiresFinanceIntel: true,
				confidence: 0.9,
				evidence: "Brokerage alert.",
			},
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["banking"],
				tags: ["banking"],
			},
		}) as unknown as Record<string, unknown>;
		parsed.routing = {
			primaryBucket: "finance",
			secondaryBuckets: ["banking", "investment"],
			tags: ["banking", "investment"],
		};
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed,
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
			accountId: "acct-1",
			messageId,
			accountLabel: "Primary Gmail",
			sender: "brokerage@example.com",
			subject: "Investment update",
			receivedAt: "2026-01-01",
			bodyText: "Investment transfer update",
			attachmentsSummary: "No attachments",
			moderationFlag: false,
			moderationScores: [],
			promptPreamble: null,
		});

		expect(result.label.finance.signal).toBe("investment");
		expect(result.label.routing.secondaryBuckets).toEqual(["banking"]);
	});

	it("classifies with default tags and persists low-confidence reviews", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.4,
					evidence: "Lunch receipt.",
				},
				people: { business: true },
				commerce: { transactional: true },
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				confidence: { overall: 0.4, finance: 0.4 },
				explanation: "Low confidence.",
			}),
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
			accountId: "acct-1",
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

		expect(result.label.schemaVersion).toBe("message-label.v3");
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
			parsed: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.4,
					evidence: "Receipt.",
				},
				people: { business: true },
				commerce: { transactional: true },
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				confidence: { overall: 0.4, finance: 0.4 },
				explanation: "Low confidence.",
			}),
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
			accountId: "acct-1",
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

	it("updates an existing open review to the newest low-confidence result", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const messageId = await insertMessageRow(db, {
			contentSha256: "review-refresh-sha",
		});
		const lowConfidenceLabel: MessageLabelV3 = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "receipt",
				operational: true,
				bookHint: "business",
				requiresFinanceIntel: true,
				confidence: 0.4,
				evidence: "Software receipt.",
			},
			people: { business: true },
			commerce: { transactional: true, subscription: true },
			knowledge: { resource: true },
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["subscription"],
				tags: ["receipt"],
			},
			confidence: {
				overall: 0.4,
				finance: 0.4,
				people: 0.6,
				commerce: 0.6,
				knowledge: 0.5,
				assets: 0.5,
				entertainment: 0.1,
				risk: 0.9,
			},
			explanation: "Low confidence.",
		});

		await classify.persistClassification({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "classify-email-v3",
			source: "model",
			rawResponse: { step: 1 },
			usage: null,
			label: lowConfidenceLabel,
		});

		const firstReview = await db
			.selectFrom("reviews")
			.select(["id", "source_classification_result_id"])
			.where("message_id", "=", messageId)
			.where("status", "=", "open")
			.executeTakeFirstOrThrow();

		await classify.persistClassification({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "classify-email-v3",
			source: "model",
			rawResponse: { step: 2 },
			usage: null,
			label: {
				...lowConfidenceLabel,
				confidence: {
					...lowConfidenceLabel.confidence,
					overall: 0.45,
					finance: 0.45,
				},
				explanation: "Still low confidence.",
			},
		});

		const latestResult = await db
			.selectFrom("classification_results")
			.select(["id"])
			.where("message_id", "=", messageId)
			.orderBy("created_at", "desc")
			.executeTakeFirstOrThrow();
		const reviews = await db
			.selectFrom("reviews")
			.select(["id", "status", "source_classification_result_id"])
			.where("message_id", "=", messageId)
			.execute();

		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({
			id: firstReview.id,
			status: "open",
			source_classification_result_id: latestResult.id,
		});
		expect(firstReview.source_classification_result_id).not.toBe(
			latestResult.id,
		);
	});

	it("auto-resolves an open review after a higher-confidence reclassification", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const messageId = await insertMessageRow(db, {
			contentSha256: "review-resolve-sha",
		});
		const lowConfidenceLabel: MessageLabelV3 = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "receipt",
				operational: true,
				bookHint: "business",
				requiresFinanceIntel: true,
				confidence: 0.4,
				evidence: "Software receipt.",
			},
			people: { business: true },
			commerce: { transactional: true, subscription: true },
			knowledge: { resource: true },
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["subscription"],
				tags: ["receipt"],
			},
			confidence: {
				overall: 0.4,
				finance: 0.4,
				people: 0.6,
				commerce: 0.6,
				knowledge: 0.5,
				assets: 0.5,
				entertainment: 0.1,
				risk: 0.9,
			},
			explanation: "Low confidence.",
		});

		await classify.persistClassification({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "classify-email-v3",
			source: "model",
			rawResponse: { step: 1 },
			usage: null,
			label: lowConfidenceLabel,
		});

		await classify.persistClassification({
			jobId: null,
			messageId,
			model: "gpt-5.4-mini",
			backend: "openai-subscription",
			promptVersion: "classify-email-v3",
			source: "model",
			rawResponse: { step: 2 },
			usage: null,
			label: {
				...lowConfidenceLabel,
				confidence: {
					...lowConfidenceLabel.confidence,
					overall: 0.92,
					finance: 0.92,
					people: 0.9,
					commerce: 0.94,
					knowledge: 0.88,
					assets: 0.87,
					risk: 0.93,
				},
				explanation: "High confidence.",
			},
		});

		const review = await db
			.selectFrom("reviews")
			.select(["status", "reviewer_note", "resolved_at"])
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();

		expect(review.status).toBe("resolved");
		expect(review.reviewer_note).toBe(
			"Resolved by higher-confidence reclassification.",
		);
		expect(review.resolved_at).toBeTruthy();
	});

	it("preserves manual labels and resolves overrides", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const classify =
			await runtime.importFresh<typeof import("#/lib/classify")>(
				"#/lib/classify",
			);
		const messageId = await insertMessageRow(db);
		const manualLabel = buildMessageLabelV3({
			finance: {
				relevant: true,
				signal: "receipt",
				operational: true,
				bookHint: "business",
				requiresFinanceIntel: true,
				confidence: 0.4,
				evidence: "Manual receipt override.",
			},
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["receipt"],
				tags: ["receipt"],
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
				confidence: {
					overall: 0.4,
					finance: 0.4,
					people: 0.4,
					commerce: 0.4,
					knowledge: 0.4,
					assets: 0.4,
					entertainment: 0.4,
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
		expect(review.override_label_json).toContain('"message-label.v3"');
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
			promptVersion: "classify-email-v3",
			source: "model",
			rawResponse: {},
			usage: null,
			label: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.9,
					evidence: "Software receipt.",
				},
				people: { business: true },
				commerce: { transactional: true, subscription: true },
				knowledge: { resource: true },
				assets: { license: true, account: true },
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
			}),
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
