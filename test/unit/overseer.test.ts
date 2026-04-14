import { describe, expect, it, vi } from "vitest";

import { bootDb, insertMessageRow } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("overseer", () => {
	it("extracts domains and top values", async () => {
		const runtime = await createTestRuntime();
		const overseer =
			await runtime.importFresh<typeof import("#/lib/overseer")>(
				"#/lib/overseer",
			);

		expect(overseer.extractDomain(null)).toBeNull();
		expect(overseer.extractDomain("invalid")).toBeNull();
		expect(overseer.extractDomain("User@Example.COM")).toBe("example.com");
		expect(
			overseer.topValues(
				[
					{ value: "b", count: 1 },
					{ value: "a", count: 2 },
				],
				1,
			),
		).toEqual(["a"]);
	});

	it("builds and loads overseer profiles from labels and reviews", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			senderAddress: "billing@example.com",
		});
		const secondMessageId = await insertMessageRow(db, {
			senderAddress: "friend@example.org",
		});

		await db
			.insertInto("classification_results")
			.values([
				{
					id: "classification-1",
					job_id: null,
					message_id: messageId,
					model: "gpt-5.4-mini",
					prompt_version: "classify-email-v1",
					source: "model",
					result_json: "{}",
					raw_response_json: "{}",
					usage_json: null,
					low_confidence: 0,
					created_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "classification-2",
					job_id: null,
					message_id: secondMessageId,
					model: "gpt-5.4-mini",
					prompt_version: "classify-email-v1",
					source: "model",
					result_json: "{}",
					raw_response_json: "{}",
					usage_json: null,
					low_confidence: 0,
					created_at: "2026-01-01T00:00:00.000Z",
				},
			])
			.execute();

		await db
			.insertInto("message_labels")
			.values([
				{
					message_id: messageId,
					classification_result_id: "classification-1",
					source: "model",
					label_json: JSON.stringify({
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
							leakRisk: true,
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
						explanation: "receipt",
					}),
					primary_bucket: "finance",
					low_confidence: 0,
					nsfw: 0,
					updated_at: "2026-01-01T00:00:00.000Z",
				},
				{
					message_id: secondMessageId,
					classification_result_id: "classification-2",
					source: "model",
					label_json: "not-json",
					primary_bucket: "personal",
					low_confidence: 0,
					nsfw: 0,
					updated_at: "2026-01-01T00:00:00.000Z",
				},
			])
			.execute();

		await db
			.insertInto("reviews")
			.values({
				id: "review-1",
				message_id: messageId,
				source_classification_result_id: "classification-1",
				status: "resolved",
				reviewer_note: "ok",
				override_label_json: "{}",
				created_at: "2026-01-01T00:00:00.000Z",
				resolved_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5-mini",
			parsed: {
				schemaVersion: "overseer-profile.v1",
				accountId: "acct-1",
				builtFromMessages: 2,
				knownBusinessDomains: ["example.com"],
				knownPersonalDomains: ["example.org"],
				knownFinancialSenders: ["billing@example.com"],
				recurringPurposeHints: ["client lunch"],
				confidentialityPatterns: ["business_sensitive", "leak_risk"],
				promotedTags: ["receipt"],
				promptPreamble: "Known sender.",
			},
			rawText: "{}",
			usage: null,
		}));
		vi.doMock("#/lib/pi", () => ({
			piJson,
		}));

		const overseer =
			await runtime.importFresh<typeof import("#/lib/overseer")>(
				"#/lib/overseer",
			);
		const profile = await overseer.buildOverseerProfile("acct-1");
		const context = await overseer.loadLatestOverseerContext("acct-1");

		expect(profile.promptPreamble).toBe("Known sender.");
		expect(context.promotedTags).toEqual(["receipt"]);
		expect(context.profile?.knownBusinessDomains).toEqual(["example.com"]);
		expect(piJson).toHaveBeenCalled();
	});

	it("checks rebuild thresholds", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db);

		await db
			.insertInto("classification_results")
			.values({
				id: "classification-3",
				job_id: null,
				message_id: messageId,
				model: "gpt-5.4-mini",
				prompt_version: "classify-email-v1",
				source: "model",
				result_json: "{}",
				raw_response_json: "{}",
				usage_json: null,
				low_confidence: 0,
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_labels")
			.values({
				message_id: messageId,
				classification_result_id: "classification-3",
				source: "model",
				label_json: "{}",
				primary_bucket: "other",
				low_confidence: 0,
				nsfw: 0,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const overseer =
			await runtime.importFresh<typeof import("#/lib/overseer")>(
				"#/lib/overseer",
			);
		expect(await overseer.maybeQueueOverseerForAccount("acct-1")).toBe(false);

		await db
			.insertInto("overseer_profiles")
			.values({
				id: "profile-1",
				account_id: "acct-1",
				built_from_messages: 0,
				promoted_tags_json: "[]",
				prompt_preamble: "none",
				profile_json: "{}",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		expect(await overseer.maybeQueueOverseerForAccount("acct-1")).toBe(false);
	});

	it("queues overseer rebuilds when the threshold is reached", async () => {
		const runtime = await createTestRuntime();
		process.env.OVERSEER_REBUILD_EVERY = "1";
		vi.resetModules();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db);

		await db
			.insertInto("classification_results")
			.values({
				id: "classification-4",
				job_id: null,
				message_id: messageId,
				model: "gpt-5.4-mini",
				prompt_version: "classify-email-v1",
				source: "model",
				result_json: "{}",
				raw_response_json: "{}",
				usage_json: null,
				low_confidence: 0,
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_labels")
			.values({
				message_id: messageId,
				classification_result_id: "classification-4",
				source: "model",
				label_json: "{}",
				primary_bucket: "other",
				low_confidence: 0,
				nsfw: 0,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const overseer =
			await runtime.importFresh<typeof import("#/lib/overseer")>(
				"#/lib/overseer",
			);
		expect(await overseer.maybeQueueOverseerForAccount("acct-1")).toBe(true);
	});
});
