import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertMessageRow,
	insertMessageSourceRow,
	seedTestAccount,
} from "#/test/helpers/db";
import { fixturePath } from "#/test/helpers/fs";
import {
	buildFinanceIntelV3,
	buildMessageLabelV3,
} from "#/test/helpers/labels";
import { createTestRuntime } from "#/test/helpers/runtime";

async function runWorkerUntilQuiet(
	worker: typeof import("#/lib/worker"),
	db: Awaited<ReturnType<typeof bootDb>>["db"],
	maxIterations = 12,
) {
	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		const handled = await worker.runWorkerIteration({ waitOnIdle: false });
		if (!handled) {
			return;
		}
	}

	const openJobs = await db
		.selectFrom("jobs")
		.select(["kind", "status", "scope_type", "scope_id"])
		.where("status", "in", ["queued", "running"])
		.orderBy("created_at", "asc")
		.execute();
	const financeHeads = await db
		.selectFrom("message_secondary_heads")
		.leftJoin(
			"message_secondary_results",
			"message_secondary_results.id",
			"message_secondary_heads.secondary_result_id",
		)
		.select([
			"message_secondary_heads.message_id",
			"message_secondary_heads.status",
			"message_secondary_heads.content_sha256",
			"message_secondary_heads.registry_sha256",
			"message_secondary_results.schema_version as result_schema_version",
		])
		.where("message_secondary_heads.classifier_key", "=", "finance_intel")
		.orderBy("message_secondary_heads.message_id", "asc")
		.execute();
	const recentJobs = await db
		.selectFrom("jobs")
		.select([
			"kind",
			"status",
			"attempts",
			"last_error",
			"scope_type",
			"scope_id",
		])
		.orderBy("created_at", "asc")
		.execute();

	throw new Error(
		`Worker did not go idle within ${String(maxIterations)} iterations. Open jobs: ${JSON.stringify(openJobs)}. Finance heads: ${JSON.stringify(financeHeads)}. Jobs: ${JSON.stringify(recentJobs)}`,
	);
}

function mockPiModule() {
	vi.doMock("#/lib/pi", () => ({
		piJson: vi.fn(async (input: { userPrompt: string }) => {
			if (input.userPrompt.includes("Allowed tags:")) {
				const lowConfidence = input.userPrompt.includes("Party invite");
				return {
					backend: "openai-subscription",
					modelId: "gpt-5.4-mini",
					parsed: buildMessageLabelV3({
						finance: {
							relevant: !lowConfidence,
							signal: lowConfidence ? "none" : "receipt",
							operational: !lowConfidence,
							bookHint: lowConfidence ? "unknown" : "business",
							requiresFinanceIntel: !lowConfidence,
							confidence: 0.9,
							evidence: lowConfidence ? null : "Client lunch receipt.",
						},
						people: {
							personal: lowConfidence,
							private: lowConfidence,
							networking: false,
							community: lowConfidence,
							recruiting: false,
							business: !lowConfidence,
						},
						routing: {
							primaryBucket: lowConfidence ? "relationships" : "finance",
							secondaryBuckets: lowConfidence ? ["community"] : ["receipt"],
							tags: lowConfidence ? ["social"] : ["receipt"],
						},
						confidence: {
							overall: lowConfidence ? 0.6 : 0.95,
							finance: 0.9,
							people: 0.9,
							commerce: 0.9,
							knowledge: 0.9,
							assets: 0.9,
							entertainment: 0.9,
							risk: 0.9,
						},
						explanation: "Worker classification.",
					}),
					rawText: "{}",
					usage: { totalTokens: 10 },
				};
			}

			if (
				input.userPrompt.includes("Sender:") &&
				input.userPrompt.includes("Normalized body:") &&
				!input.userPrompt.includes("Current root label:")
			) {
				return {
					backend: "openai-subscription",
					modelId: "gpt-5.4-mini",
					parsed: {
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
							suggestiveSexual: 0.1,
							nudity: 0.1,
							sexualMinors: 0,
							adultCommercial: 0.1,
							overall: 0.1,
						},
						explanation: "Safe.",
					},
					rawText: "{}",
					usage: { totalTokens: 8 },
				};
			}

			if (
				input.userPrompt.includes("Current root label:") &&
				input.userPrompt.includes("Matched operator registry context:")
			) {
				return {
					backend: "openai-subscription",
					modelId: "gpt-5.4-mini",
					parsed: buildFinanceIntelV3({
						messageKind: "receipt",
						transactionCandidates: [
							{
								kind: "card_charge",
								direction: "expense",
								amount: "42.00",
								currency: "USD",
								occurredAt: "2026-01-01",
								merchantOrCounterparty: "billing@example.com",
								ownerIdentityRef: null,
								financialAccountRef: null,
								institutionRef: null,
								categoryPrimary: "meals",
								categorySecondary: "client_meals",
								statementRefHint: null,
								taxRelevanceHint: "business expense",
								evidence: "Expense receipt for client lunch",
								externalTransactionId: null,
								postedAt: null,
								clearedAt: null,
								book: "business",
								businessUsePercent: null,
								fieldConfidence: {
									amount: 0.95,
									date: 0.95,
									counterparty: 0.95,
									accountMapping: 0.95,
									book: 0.95,
									category: 0.95,
									dedupe: 0.95,
								},
								dedupe: {
									externalTransactionId: null,
									statementRowId: null,
									normalizedComposite: null,
									emailEvidenceKey: "msg-receipt:42:2026-01-01",
								},
								beancount: {
									debitAccount: "Expenses:Business:Meals",
									creditAccount: "Assets:Business:Bank:Checking",
									currency: "USD",
									mappingKey: "amex",
									confidence: 0.95,
									metadata: {},
								},
							},
						],
						documentCandidates: [
							{
								documentType: "receipt",
								issuer: "billing@example.com",
								externalId: null,
								statementPeriodStart: null,
								statementPeriodEnd: null,
								dueAt: null,
								taxYear: 2026,
								accountRefHint: null,
								institutionRefHint: null,
								attachmentRefs: ["receipt.pdf"],
								evidence: "Receipt attachment present",
								sourceDocumentRefs: ["receipt.pdf"],
								statementOpeningBalance: null,
								statementClosingBalance: null,
								statementTransactionCount: null,
								statementCurrency: "USD",
								book: "business",
								fieldConfidence: {
									amount: null,
									date: 0.9,
									counterparty: 0.9,
									accountMapping: 0.8,
									book: 0.95,
									category: 0.9,
									dedupe: 0.8,
								},
							},
						],
						explanation: "Finance intel.",
					}),
					rawText: "{}",
					usage: { totalTokens: 9 },
				};
			}

			return {
				backend: "openai-subscription",
				modelId: "gpt-5-mini",
				parsed: {
					schemaVersion: "overseer-profile.v1",
					accountId: "acct-1",
					builtFromMessages: 3,
					knownBusinessDomains: ["billing@example.com"],
					knownPersonalDomains: ["friend@example.org"],
					knownFinancialSenders: ["billing@example.com"],
					recurringPurposeHints: ["client lunch"],
					confidentialityPatterns: [],
					promotedTags: ["receipt", "social"],
					promptPreamble: "Known sender profile.",
				},
				rawText: "{}",
				usage: { totalTokens: 12 },
			};
		}),
		getPiStatus: vi.fn(async () => ({
			subscriptionConfigured: true,
			apiConfigured: false,
			preferredBackend: "auto",
			resolvedBackend: "openai-subscription",
		})),
	}));
}

describe("worker and server actions", () => {
	it("classifies live backlog, rebuilds overseer, and loads live-only server data", async () => {
		const runtime = await createTestRuntime();
		mockPiModule();

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			label: "Primary Gmail",
			syncEnabled: 1,
		});

		const receiptMessageId = await insertMessageRow(db, {
			id: "msg-receipt",
			accountId: "acct-1",
			senderAddress: "billing@example.com",
			subject: "Receipt",
			bodyTextNormalized: "Expense receipt for client lunch",
			contentSha256: "sha-receipt",
		});
		const reviewMessageId = await insertMessageRow(db, {
			id: "msg-review",
			accountId: "acct-1",
			senderAddress: "friend@example.com",
			subject: "Party invite",
			bodyTextNormalized: "Party invite for Saturday night",
			contentSha256: "sha-review",
		});
		await db
			.insertInto("attachments")
			.values({
				id: "att-receipt",
				message_id: receiptMessageId,
				filename: "receipt.pdf",
				mime_type: "application/pdf",
				size_bytes: 42,
				content_id: null,
				is_inline: 0,
			})
			.execute();
		await insertMessageSourceRow(db, {
			messageId: receiptMessageId,
			accountId: "acct-1",
			remoteMessageId: "gm-receipt",
			remoteThreadId: "thr-receipt",
			rawRfc822Path: "/tmp/gm-receipt.eml",
			rawSha256: "gm-receipt-sha",
			firstSeenAt: "2026-01-01T00:00:00.000Z",
			lastSeenAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		await insertMessageSourceRow(db, {
			messageId: reviewMessageId,
			accountId: "acct-1",
			remoteMessageId: "gm-review",
			remoteThreadId: "thr-review",
			state: "tombstoned",
			rawRfc822Path: "/tmp/gm-review.eml",
			rawSha256: "gm-review-sha",
			firstSeenAt: "2026-01-01T00:00:00.000Z",
			lastSeenAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
			tombstonedAt: "2026-01-02T00:00:00.000Z",
		});

		await actions.queueAccountClassifyBacklogCommand({ accountId: "acct-1" });
		await runWorkerUntilQuiet(worker, db);

		const labels = await db.selectFrom("message_labels").selectAll().execute();
		const reviews = await db.selectFrom("reviews").selectAll().execute();
		expect(labels).toHaveLength(2);
		expect(reviews).toHaveLength(1);

		const home = await actions.loadHomeData();
		expect(home.messages).toBe(2);
		expect(home.openReviews).toBe(1);
		expect(home.accounts).toBe(1);
		expect(home.jobs).toBeGreaterThanOrEqual(1);

		const runs = await actions.loadRunsData();
		expect(runs.runtime.resolvedBackend).toBe("openai-subscription");
		expect(runs.jobs.every((job) => !job.kind.includes("import"))).toBe(true);
		expect(
			runs.jobs.some((job) => job.kind === "classify_account_backlog"),
		).toBe(true);
		expect(
			runs.jobs.some((job) => job.kind === "classify_finance_backlog"),
		).toBe(true);

		const messagesData = await actions.loadMessagesData();
		expect(messagesData.rows).toHaveLength(2);

		const detail = await actions.loadMessageDetailData({
			messageId: receiptMessageId,
		});
		expect(detail.attachments).toHaveLength(1);
		expect(detail.classifications.length).toBeGreaterThan(0);
		expect(detail.currentLabel).toBeTruthy();

		const reviewData = await actions.loadReviewData();
		expect(reviewData.rootReviews).toHaveLength(1);
		await expect(
			actions.resolveReviewCommand({
				reviewId: reviewData.rootReviews[0].id,
				action: "override",
			}),
		).rejects.toThrow("Override label is required for override action");

		await actions.enqueueOverseerCommand({ accountId: "acct-1" });
		await runWorkerUntilQuiet(worker, db);
		const profileData = await actions.loadProfileData({ accountId: "acct-1" });
		expect(profileData.profiles.length).toBeGreaterThan(0);
		expect(
			profileData.financeCoverage.rootFinanceRelevantCount,
		).toBeGreaterThan(0);
		const detailAfterProfile = await actions.loadMessageDetailData({
			messageId: receiptMessageId,
		});
		expect(detailAfterProfile.latestProfile).toBeTruthy();

		await actions.queueAccountFinanceBacklogCommand({ accountId: "acct-1" });
		await runWorkerUntilQuiet(worker, db);
		const financeData = await actions.loadFinanceData();
		expect(financeData.coverage).toBeTruthy();
		expect(Array.isArray(financeData.ledgerPreview)).toBe(true);
		expect(Array.isArray(financeData.reviewRows)).toBe(true);

		const classifyNow = await actions.classifyOneNowCommand({
			messageId: receiptMessageId,
		});
		expect(classifyNow.status).toBe("queued");
		expect(classifyNow.jobId).toBeTruthy();

		const accepted = await actions.resolveReviewCommand({
			reviewId: reviewData.rootReviews[0].id,
			action: "accept",
		});
		expect(accepted.status).toBe("accepted");

		const overrideMessageId = await insertMessageRow(db, {
			id: "msg-override",
			accountId: "acct-1",
			senderAddress: "friend@example.com",
			subject: "Party invite follow-up",
			bodyTextNormalized: "Party invite after work",
			contentSha256: "sha-override",
		});
		await actions.queueAccountClassifyBacklogCommand({ accountId: "acct-1" });
		await runWorkerUntilQuiet(worker, db);

		const overrideReview = await db
			.selectFrom("reviews")
			.selectAll()
			.where("message_id", "=", overrideMessageId)
			.where("status", "=", "open")
			.executeTakeFirstOrThrow();
		const manualOverride = JSON.parse(
			await readFile(fixturePath("review", "manual-override.json"), "utf8"),
		);
		const overridden = await actions.resolveReviewCommand({
			reviewId: overrideReview.id,
			action: "override",
			override: manualOverride,
		});
		expect(overridden.status).toBe("overridden");
	});

	it("loads null detail branches and classifies fallback fields for live messages", async () => {
		const runtime = await createTestRuntime();
		mockPiModule();

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const worker =
			await runtime.importFresh<typeof import("#/lib/worker")>("#/lib/worker");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "msg-fallback",
			accountId: "acct-1",
			senderAddress: null,
			subject: null,
			receivedAt: null,
			bodyTextNormalized: "plain body",
			contentSha256: "sha-fallback",
		});

		const detail = await actions.loadMessageDetailData({ messageId });
		expect(detail.moderation).toBeNull();
		expect(detail.currentLabel).toBeNull();
		expect(detail.latestProfile).toBeNull();
		const rowsBeforeLabel = await actions.loadMessagesData();
		expect(
			rowsBeforeLabel.rows.some(
				(row) => row.id === messageId && row.label === null,
			),
		).toBe(true);

		const result = await actions.classifyOneNowCommand({ messageId });
		expect(result.status).toBe("queued");
		await runWorkerUntilQuiet(worker, db);

		const latestLabel = await dbModule
			.getDb()
			.selectFrom("message_labels")
			.selectAll()
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();
		expect(latestLabel.source).toBe("model");
	});
});
