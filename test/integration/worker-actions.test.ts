import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { bootDb, insertMessageRow, seedTestAccount } from "#/test/helpers/db";
import { fixturePath } from "#/test/helpers/fs";
import { createTestRuntime } from "#/test/helpers/runtime";

function mockPiModule() {
	vi.doMock("#/lib/pi", () => ({
		piJson: vi.fn(async (input: { userPrompt: string }) => {
			if (input.userPrompt.includes("Allowed tags:")) {
				const lowConfidence = input.userPrompt.includes("Party invite");
				return {
					backend: "openai-subscription",
					modelId: "gpt-5.4-mini",
					parsed: {
						finance: {
							relevant: !lowConfidence,
							direction: lowConfidence ? "neither" : "expense",
							owner: lowConfidence ? "unknown" : "business",
							accountHint: lowConfidence ? null : "amex",
							purpose: lowConfidence ? null : "client lunch",
						},
						social: {
							personal: lowConfidence,
							private: lowConfidence,
							social: lowConfidence,
							business: !lowConfidence,
						},
						risk: {
							businessSensitive: false,
							leakRisk: false,
						},
						routing: {
							primaryBucket: lowConfidence ? "personal" : "finance",
							tags: lowConfidence ? ["social"] : ["receipt"],
						},
						confidence: {
							overall: lowConfidence ? 0.6 : 0.95,
							finance: 0.9,
							social: 0.9,
							risk: 0.9,
						},
						explanation: "Worker classification.",
					},
					rawText: "{}",
					usage: { totalTokens: 10 },
				};
			}

			if (
				input.userPrompt.includes("Sender:") &&
				input.userPrompt.includes("Normalized body:")
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
					parsed: {
						schemaVersion: "finance-intel.v1",
						messageKind: "receipt",
						actionability: "create_transaction_candidate",
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
								categoryHint: "client lunch",
								taxRelevanceHint: "business expense",
								evidence: "Expense receipt for client lunch",
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
								attachmentRefs: ["receipt.pdf"],
								evidence: "Receipt attachment present",
							},
						],
						matchedRegistryRefs: {
							identityIds: [],
							institutionIds: [],
							financialAccountIds: [],
						},
						unresolvedEntityHints: {
							identityHints: [],
							institutionHints: [],
							financialAccountHints: [],
						},
						confidence: {
							overall: 0.95,
							messageKind: 0.95,
							transactionExtraction: 0.95,
							registryMatching: 0.95,
						},
						explanation: "Finance intel.",
					},
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

async function insertMessageSource(
	db: Awaited<ReturnType<typeof bootDb>>["db"],
	input: {
		messageId: string;
		accountId: string;
		remoteMessageId: string;
		remoteThreadId: string;
		state?: "active" | "tombstoned";
	},
) {
	await db
		.insertInto("message_sources")
		.values({
			id: `source-${input.messageId}`,
			message_id: input.messageId,
			account_id: input.accountId,
			remote_message_id: input.remoteMessageId,
			remote_thread_id: input.remoteThreadId,
			mailbox: "[Gmail]/All Mail",
			imap_uid: 1,
			uidvalidity: 1,
			raw_rfc822_path: `/tmp/${input.remoteMessageId}.eml`,
			raw_sha256: `${input.remoteMessageId}-sha`,
			state: input.state ?? "active",
			first_seen_at: "2026-01-01T00:00:00.000Z",
			last_seen_at: "2026-01-01T00:00:00.000Z",
			tombstoned_at:
				input.state === "tombstoned" ? "2026-01-02T00:00:00.000Z" : null,
			updated_at: "2026-01-02T00:00:00.000Z",
		})
		.execute();
}

describe("worker and server actions", () => {
	it("classifies live backlog, rebuilds overseer, and loads live-only server data", async () => {
		const runtime = await createTestRuntime();
		mockPiModule();

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions.server")
		>("#/app/server/actions.server");
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
		await insertMessageSource(db, {
			messageId: receiptMessageId,
			accountId: "acct-1",
			remoteMessageId: "gm-receipt",
			remoteThreadId: "thr-receipt",
		});
		await insertMessageSource(db, {
			messageId: reviewMessageId,
			accountId: "acct-1",
			remoteMessageId: "gm-review",
			remoteThreadId: "thr-review",
			state: "tombstoned",
		});

		await actions.queueAccountClassifyBacklogCommand({ accountId: "acct-1" });
		await worker.drainWorkerUntilIdle();

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
		expect(messagesData).toHaveLength(2);

		const detail = await actions.loadMessageDetailData({
			messageId: receiptMessageId,
		});
		expect(detail.attachments).toHaveLength(1);
		expect(detail.classifications.length).toBeGreaterThan(0);
		expect(detail.currentLabel).toBeTruthy();

		const reviewData = await actions.loadReviewData();
		expect(reviewData).toHaveLength(1);
		await expect(
			actions.resolveReviewCommand({
				reviewId: reviewData[0].id,
				action: "override",
			}),
		).rejects.toThrow("Override label is required for override action");

		await actions.enqueueOverseerCommand({ accountId: "acct-1" });
		await worker.drainWorkerUntilIdle();
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
		await worker.drainWorkerUntilIdle();
		const financeData = await actions.loadFinanceData();
		expect(financeData.coverage).toBeTruthy();
		expect(Array.isArray(financeData.eventCandidates)).toBe(true);
		expect(Array.isArray(financeData.documentCandidates)).toBe(true);

		const classifyNow = await actions.classifyOneNowCommand({
			messageId: receiptMessageId,
		});
		expect(classifyNow.status).toBe("classified");
		const classifyNowLabel = await db
			.selectFrom("message_labels")
			.select(["label_json"])
			.where("message_id", "=", receiptMessageId)
			.executeTakeFirstOrThrow();
		expect(classifyNowLabel.label_json).toContain("message-label.v2");

		const accepted = await actions.resolveReviewCommand({
			reviewId: reviewData[0].id,
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
		await worker.drainWorkerUntilIdle();

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

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions.server")
		>("#/app/server/actions.server");
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
			rowsBeforeLabel.some((row) => row.id === messageId && row.label === null),
		).toBe(true);

		const result = await actions.classifyOneNowCommand({ messageId });
		expect(result.status).toBe("classified");

		const latestLabel = await dbModule
			.getDb()
			.selectFrom("message_labels")
			.selectAll()
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();
		expect(latestLabel.source).toBe("model");
	});
});
