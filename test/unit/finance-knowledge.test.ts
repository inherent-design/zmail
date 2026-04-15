import { describe, expect, it } from "vitest";

import {
	bootDb,
	insertConversationRow,
	insertMessageLabelRow,
	insertMessageRow,
	insertSecondaryResultRow,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("finance knowledge", () => {
	it("materializes finance event and document candidates from finance-intel heads", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const conversationId = await insertConversationRow(db, {
			id: "conv-finance",
			accountId: "acct-1",
			gmailThreadId: "gmail-thread-finance",
			firstMessageReceivedAt: "2026-01-10T00:00:00.000Z",
			lastMessageReceivedAt: "2026-01-10T00:00:00.000Z",
			messageCount: 1,
		});
		const messageId = await insertMessageRow(db, {
			id: "message-finance",
			accountId: "acct-1",
			conversationId,
			receivedAt: "2026-01-10T00:00:00.000Z",
			contentSha256: "message-content-sha",
		});
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "message-content-sha",
			label: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "business checking",
					purpose: "software subscription",
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
					overall: 0.95,
					finance: 0.95,
					social: 0.95,
					risk: 0.95,
				},
				explanation: "ok",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId,
			contentSha256: "message-content-sha",
			registrySha256: "registry-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-09",
						merchantOrCounterparty: "Acme Software",
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Receipt total 42.00 USD",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "Acme Software",
						externalId: "receipt-123",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: [],
						evidence: "Receipt #123 attached",
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
				explanation: "ok",
			},
		});

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();

		const eventCandidates = await db
			.selectFrom("finance_event_candidates")
			.selectAll()
			.execute();
		const documentCandidates = await db
			.selectFrom("finance_document_candidates")
			.selectAll()
			.execute();
		const evidenceRows = await db
			.selectFrom("finance_event_evidence")
			.selectAll()
			.execute();

		expect(result).toEqual({
			events: 1,
			documents: 1,
			evidence: 2,
		});
		expect(eventCandidates).toHaveLength(1);
		expect(documentCandidates).toHaveLength(1);
		expect(evidenceRows).toHaveLength(2);
		expect(eventCandidates[0]?.event_kind).toBe("card_charge");
		expect(documentCandidates[0]?.document_type).toBe("receipt");
	});

	it("marks review candidates and falls back to message-scoped canonical keys", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			id: "message-finance-review",
			accountId: "acct-1",
			conversationId: null,
			receivedAt: "2026-01-11T00:00:00.000Z",
			contentSha256: "message-review-sha",
		});
		const laterMessageId = await insertMessageRow(db, {
			id: "message-finance-review-later",
			accountId: "acct-1",
			conversationId: null,
			receivedAt: "2026-01-12T00:00:00.000Z",
			contentSha256: "message-review-later-sha",
		});
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "message-review-sha",
			label: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "corp card",
					purpose: "statement",
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
					tags: ["statement"],
				},
				confidence: {
					overall: 0.8,
					finance: 0.8,
					social: 0.8,
					risk: 0.8,
				},
				explanation: "review",
			},
		});
		await insertMessageLabelRow(db, {
			messageId: laterMessageId,
			primaryBucket: "finance",
			contentSha256: "message-review-later-sha",
			label: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "corp card",
					purpose: "statement",
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
					tags: ["statement"],
				},
				confidence: {
					overall: 0.9,
					finance: 0.9,
					social: 0.9,
					risk: 0.9,
				},
				explanation: "ready",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId,
			status: "review",
			contentSha256: "message-review-sha",
			registrySha256: "registry-review-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "statement",
				actionability: "manual_review",
				transactionCandidates: [
					{
						kind: "statement_balance",
						direction: "neither",
						amount: null,
						currency: null,
						occurredAt: null,
						merchantOrCounterparty: null,
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: null,
						taxRelevanceHint: null,
						evidence: "Balance alert",
					},
				],
				documentCandidates: [
					{
						documentType: "statement",
						issuer: null,
						externalId: null,
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: null,
						attachmentRefs: [],
						evidence: "Statement ready",
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
					overall: 0.7,
					messageKind: 0.7,
					transactionExtraction: 0.7,
					registryMatching: 0.7,
				},
				explanation: "review",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId: laterMessageId,
			status: "ready",
			contentSha256: "message-review-later-sha",
			registrySha256: "registry-review-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "statement",
				actionability: "capture_document",
				transactionCandidates: [
					{
						kind: "statement_balance",
						direction: "neither",
						amount: null,
						currency: null,
						occurredAt: null,
						merchantOrCounterparty: null,
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: null,
						taxRelevanceHint: null,
						evidence: "Balance alert follow-up",
					},
				],
				documentCandidates: [
					{
						documentType: "statement",
						issuer: null,
						externalId: null,
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: null,
						attachmentRefs: [],
						evidence: "Statement reminder",
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
					overall: 0.9,
					messageKind: 0.9,
					transactionExtraction: 0.9,
					registryMatching: 0.9,
				},
				explanation: "ready",
			},
		});
		await db
			.insertInto("message_secondary_results")
			.values({
				id: "secondary-ignore",
				message_id: messageId,
				classifier_key: "finance_intel",
				schema_version: "finance-intel.v1",
				job_id: null,
				model: "gpt-5.4-mini",
				prompt_version: "finance-intel-v1",
				source: "model",
				result_json: "null",
				raw_response_json: "{}",
				usage_json: null,
				input_content_sha256: "message-review-sha",
				input_registry_sha256: "registry-review-sha",
				created_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();

		const eventCandidate = await db
			.selectFrom("finance_event_candidates")
			.select([
				"canonical_key",
				"status",
				"first_message_received_at",
				"last_message_received_at",
			])
			.where("canonical_key", "=", "tx:message:message-finance-review:0")
			.executeTakeFirstOrThrow();
		const documentCandidate = await db
			.selectFrom("finance_document_candidates")
			.select([
				"canonical_key",
				"status",
				"first_message_received_at",
				"last_message_received_at",
			])
			.where("canonical_key", "=", "doc:message:message-finance-review:0")
			.executeTakeFirstOrThrow();

		expect(result).toEqual({
			events: 2,
			documents: 2,
			evidence: 4,
		});
		expect(eventCandidate).toEqual({
			canonical_key: "tx:message:message-finance-review:0",
			status: "review",
			first_message_received_at: "2026-01-11T00:00:00.000Z",
			last_message_received_at: "2026-01-11T00:00:00.000Z",
		});
		expect(documentCandidate).toEqual({
			canonical_key: "doc:message:message-finance-review:0",
			status: "review",
			first_message_received_at: "2026-01-11T00:00:00.000Z",
			last_message_received_at: "2026-01-11T00:00:00.000Z",
		});
	});

	it("skips invalid finance-intel payloads and backfills earlier timestamps during merges", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const laterMessageId = await insertMessageRow(db, {
			id: "message-finance-backfill-aaa-later",
			accountId: "acct-1",
			receivedAt: "2026-01-12T00:00:00.000Z",
			contentSha256: "message-backfill-later-sha",
		});
		const earlierMessageId = await insertMessageRow(db, {
			id: "message-finance-backfill-zzz-earlier",
			accountId: "acct-1",
			receivedAt: "2026-01-09T00:00:00.000Z",
			contentSha256: "message-backfill-earlier-sha",
		});
		const ignoredMessageId = await insertMessageRow(db, {
			id: "message-finance-backfill-ignored",
			accountId: "acct-1",
			receivedAt: "2026-01-10T00:00:00.000Z",
			contentSha256: "message-backfill-ignored-sha",
		});

		for (const [messageId, contentSha256] of [
			[laterMessageId, "message-backfill-later-sha"],
			[earlierMessageId, "message-backfill-earlier-sha"],
			[ignoredMessageId, "message-backfill-ignored-sha"],
		] as const) {
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket: "finance",
				contentSha256,
				label: {
					schemaVersion: "message-label.v1",
					nsfw: false,
					finance: {
						relevant: true,
						direction: "expense",
						owner: "business",
						accountHint: "business card",
						purpose: "software",
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
						overall: 0.95,
						finance: 0.95,
						social: 0.95,
						risk: 0.95,
					},
					explanation: "finance",
				},
			});
		}

		await insertSecondaryResultRow(db, {
			messageId: laterMessageId,
			status: "ready",
			contentSha256: "message-backfill-later-sha",
			registrySha256: "registry-backfill-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-08",
						merchantOrCounterparty: "Acme Software",
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Later receipt",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "Acme Software",
						externalId: "receipt-backfill-1",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: [],
						evidence: "Later receipt",
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
				explanation: "ok",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId: earlierMessageId,
			status: "ready",
			contentSha256: "message-backfill-earlier-sha",
			registrySha256: "registry-backfill-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-08",
						merchantOrCounterparty: "Acme Software",
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Earlier receipt",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "Acme Software",
						externalId: "receipt-backfill-1",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: [],
						evidence: "Earlier receipt",
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
				explanation: "ok",
			},
		});
		await db
			.insertInto("message_secondary_results")
			.values({
				id: "secondary-backfill-ignored",
				message_id: ignoredMessageId,
				classifier_key: "finance_intel",
				schema_version: "finance-intel.v1",
				job_id: null,
				model: "gpt-5.4-mini",
				prompt_version: "finance-intel-v1",
				source: "model",
				result_json: "null",
				raw_response_json: "{}",
				usage_json: null,
				input_content_sha256: "message-backfill-ignored-sha",
				input_registry_sha256: "registry-backfill-sha",
				created_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_secondary_heads")
			.values({
				message_id: ignoredMessageId,
				classifier_key: "finance_intel",
				secondary_result_id: "secondary-backfill-ignored",
				status: "ready",
				low_confidence: 0,
				content_sha256: "message-backfill-ignored-sha",
				registry_sha256: "registry-backfill-sha",
				updated_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();

		const eventCandidate = await db
			.selectFrom("finance_event_candidates")
			.select([
				"first_message_received_at",
				"last_message_received_at",
				"evidence_count",
			])
			.executeTakeFirstOrThrow();
		const documentCandidate = await db
			.selectFrom("finance_document_candidates")
			.select([
				"first_message_received_at",
				"last_message_received_at",
				"evidence_count",
			])
			.executeTakeFirstOrThrow();

		expect(result).toEqual({
			events: 1,
			documents: 1,
			evidence: 4,
		});
		expect(eventCandidate).toEqual({
			first_message_received_at: "2026-01-09T00:00:00.000Z",
			last_message_received_at: "2026-01-12T00:00:00.000Z",
			evidence_count: 2,
		});
		expect(documentCandidate).toEqual({
			first_message_received_at: "2026-01-09T00:00:00.000Z",
			last_message_received_at: "2026-01-12T00:00:00.000Z",
			evidence_count: 2,
		});
	});

	it("falls back to conversation-scoped transaction keys when only amount and date are stable", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const conversationId = await insertConversationRow(db, {
			id: "conv-finance-conversation-key",
			accountId: "acct-1",
			gmailThreadId: "gmail-thread-conversation-key",
			firstMessageReceivedAt: "2026-01-10T00:00:00.000Z",
			lastMessageReceivedAt: "2026-01-10T00:00:00.000Z",
			messageCount: 1,
		});
		const messageId = await insertMessageRow(db, {
			id: "message-finance-conversation-key",
			accountId: "acct-1",
			conversationId,
			receivedAt: "2026-01-10T00:00:00.000Z",
			contentSha256: "message-conversation-key-sha",
		});
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "message-conversation-key-sha",
			label: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: null,
					purpose: "transfer",
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
					tags: ["transfer"],
				},
				confidence: {
					overall: 0.95,
					finance: 0.95,
					social: 0.95,
					risk: 0.95,
				},
				explanation: "finance",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId,
			status: "ready",
			contentSha256: "message-conversation-key-sha",
			registrySha256: "registry-conversation-key-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "transfer_confirmation",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "bank_transfer",
						direction: "expense",
						amount: "125.00",
						currency: null,
						occurredAt: "2026-01-08",
						merchantOrCounterparty: null,
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: null,
						taxRelevanceHint: null,
						evidence: "Transfer confirmed",
					},
				],
				documentCandidates: [],
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
				explanation: "ok",
			},
		});

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		await financeKnowledge.rebuildFinanceKnowledge();

		const eventCandidate = await db
			.selectFrom("finance_event_candidates")
			.select(["canonical_key"])
			.executeTakeFirstOrThrow();
		expect(eventCandidate.canonical_key).toBe(
			"tx:conversation:conv-finance-conversation-key:125.00:2026-01-08",
		);
	});

	it("preserves non-null received-at bounds when merged evidence includes null timestamps", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const nullFirstMessageId = await insertMessageRow(db, {
			id: "message-finance-null-received-a",
			accountId: "acct-1",
			receivedAt: null,
			contentSha256: "message-null-received-a-sha",
		});
		const datedMessageId = await insertMessageRow(db, {
			id: "message-finance-null-received-b",
			accountId: "acct-1",
			receivedAt: "2026-01-10T00:00:00.000Z",
			contentSha256: "message-null-received-b-sha",
		});
		const nullLastMessageId = await insertMessageRow(db, {
			id: "message-finance-null-received-c",
			accountId: "acct-1",
			receivedAt: null,
			contentSha256: "message-null-received-c-sha",
		});
		for (const [messageId, contentSha256] of [
			[nullFirstMessageId, "message-null-received-a-sha"],
			[datedMessageId, "message-null-received-b-sha"],
			[nullLastMessageId, "message-null-received-c-sha"],
		] as const) {
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket: "finance",
				contentSha256,
				label: {
					schemaVersion: "message-label.v1",
					nsfw: false,
					finance: {
						relevant: true,
						direction: "expense",
						owner: "business",
						accountHint: "business card",
						purpose: "software",
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
						overall: 0.95,
						finance: 0.95,
						social: 0.95,
						risk: 0.95,
					},
					explanation: "finance",
				},
			});
		}
		for (const [messageId, contentSha256, evidence] of [
			[nullFirstMessageId, "message-null-received-a-sha", "Null timestamp"],
			[datedMessageId, "message-null-received-b-sha", "Dated timestamp"],
			[nullLastMessageId, "message-null-received-c-sha", "Null timestamp tail"],
		] as const) {
			await insertSecondaryResultRow(db, {
				messageId,
				status: "ready",
				contentSha256,
				registrySha256: "registry-null-received-sha",
				result: {
					schemaVersion: "finance-intel.v1",
					messageKind: "receipt",
					actionability: "create_transaction_candidate",
					transactionCandidates: [
						{
							kind: "card_charge",
							direction: "expense",
							amount: "42.00",
							currency: "USD",
							occurredAt: "2026-01-08",
							merchantOrCounterparty: "Acme Software",
							ownerIdentityRef: null,
							financialAccountRef: null,
							institutionRef: null,
							categoryHint: "software",
							taxRelevanceHint: "business expense",
							evidence,
						},
					],
					documentCandidates: [
						{
							documentType: "receipt",
							issuer: "Acme Software",
							externalId: "receipt-null-received",
							statementPeriodStart: null,
							statementPeriodEnd: null,
							dueAt: null,
							taxYear: 2026,
							attachmentRefs: [],
							evidence,
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
					explanation: "ok",
				},
			});
		}

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		await financeKnowledge.rebuildFinanceKnowledge();

		const eventCandidate = await db
			.selectFrom("finance_event_candidates")
			.select(["first_message_received_at", "last_message_received_at"])
			.executeTakeFirstOrThrow();
		const documentCandidate = await db
			.selectFrom("finance_document_candidates")
			.select(["first_message_received_at", "last_message_received_at"])
			.executeTakeFirstOrThrow();

		expect(eventCandidate).toEqual({
			first_message_received_at: "2026-01-10T00:00:00.000Z",
			last_message_received_at: "2026-01-10T00:00:00.000Z",
		});
		expect(documentCandidate).toEqual({
			first_message_received_at: "2026-01-10T00:00:00.000Z",
			last_message_received_at: "2026-01-10T00:00:00.000Z",
		});
	});

	it("merges matching finance candidates and updates first/last message timestamps", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("registry_institutions")
			.values({
				id: "institution-1",
				display_name: "Acme Bank",
				aliases_json: "[]",
				domains_json: "[]",
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_financial_accounts")
			.values({
				id: "account-1",
				institution_id: "institution-1",
				owner_identity_id: null,
				display_name: "Business Card",
				aliases_json: "[]",
				account_mask: null,
				account_last4: null,
				account_type: null,
				currency: null,
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		const earlierMessageId = await insertMessageRow(db, {
			id: "message-finance-merge-earlier",
			accountId: "acct-1",
			receivedAt: "2026-01-09T00:00:00.000Z",
			contentSha256: "message-merge-earlier-sha",
		});
		const laterMessageId = await insertMessageRow(db, {
			id: "message-finance-merge-later",
			accountId: "acct-1",
			receivedAt: "2026-01-12T00:00:00.000Z",
			contentSha256: "message-merge-later-sha",
		});
		for (const [messageId, contentSha256] of [
			[earlierMessageId, "message-merge-earlier-sha"],
			[laterMessageId, "message-merge-later-sha"],
		] as const) {
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket: "finance",
				contentSha256,
				label: {
					schemaVersion: "message-label.v1",
					nsfw: false,
					finance: {
						relevant: true,
						direction: "expense",
						owner: "business",
						accountHint: "business card",
						purpose: "software",
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
						overall: 0.95,
						finance: 0.95,
						social: 0.95,
						risk: 0.95,
					},
					explanation: "finance",
				},
			});
		}
		await insertSecondaryResultRow(db, {
			messageId: earlierMessageId,
			status: "ready",
			contentSha256: "message-merge-earlier-sha",
			registrySha256: "registry-merge-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-08",
						merchantOrCounterparty: "Acme Software",
						ownerIdentityRef: null,
						financialAccountRef: "account-1",
						institutionRef: "institution-1",
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Receipt one",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "Acme Software",
						externalId: "receipt-merge-1",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: [],
						evidence: "Receipt one",
					},
				],
				matchedRegistryRefs: {
					identityIds: [],
					institutionIds: ["institution-1"],
					financialAccountIds: ["account-1"],
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
				explanation: "ok",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId: laterMessageId,
			status: "review",
			contentSha256: "message-merge-later-sha",
			registrySha256: "registry-merge-sha",
			result: {
				schemaVersion: "finance-intel.v1",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "expense",
						amount: "42.00",
						currency: "USD",
						occurredAt: "2026-01-08",
						merchantOrCounterparty: "Acme Software",
						ownerIdentityRef: null,
						financialAccountRef: "account-1",
						institutionRef: "institution-1",
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Receipt two",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "Acme Software",
						externalId: "receipt-merge-1",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: [],
						evidence: "Receipt two",
					},
				],
				matchedRegistryRefs: {
					identityIds: [],
					institutionIds: ["institution-1"],
					financialAccountIds: ["account-1"],
				},
				unresolvedEntityHints: {
					identityHints: [],
					institutionHints: [],
					financialAccountHints: [],
				},
				confidence: {
					overall: 0.8,
					messageKind: 0.8,
					transactionExtraction: 0.8,
					registryMatching: 0.8,
				},
				explanation: "review",
			},
		});

		const financeKnowledge = await runtime.importFresh<
			typeof import("#/lib/finance-knowledge")
		>("#/lib/finance-knowledge");
		const result = await financeKnowledge.rebuildFinanceKnowledge();

		const eventCandidate = await db
			.selectFrom("finance_event_candidates")
			.select([
				"status",
				"first_message_received_at",
				"last_message_received_at",
				"evidence_count",
			])
			.executeTakeFirstOrThrow();
		const documentCandidate = await db
			.selectFrom("finance_document_candidates")
			.select([
				"status",
				"first_message_received_at",
				"last_message_received_at",
				"evidence_count",
			])
			.executeTakeFirstOrThrow();

		expect(result).toEqual({
			events: 1,
			documents: 1,
			evidence: 4,
		});
		expect(eventCandidate).toEqual({
			status: "review",
			first_message_received_at: "2026-01-09T00:00:00.000Z",
			last_message_received_at: "2026-01-12T00:00:00.000Z",
			evidence_count: 2,
		});
		expect(documentCandidate).toEqual({
			status: "review",
			first_message_received_at: "2026-01-09T00:00:00.000Z",
			last_message_received_at: "2026-01-12T00:00:00.000Z",
			evidence_count: 2,
		});
	});
});
