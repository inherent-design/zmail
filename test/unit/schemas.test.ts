import { describe, expect, it } from "vitest";

import {
	accountRecordSchema,
	messageLabelSchema,
	messageModerationSchema,
	resolveReviewInputSchema,
} from "#/lib/schemas";

const validLabel = {
	schemaVersion: "message-label.v1",
	nsfw: false,
	finance: {
		relevant: true,
		direction: "expense",
		owner: "business",
		accountHint: "corp-card",
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
		overall: 0.9,
		finance: 0.95,
		social: 0.85,
		risk: 0.8,
	},
	explanation: "Clear expense receipt.",
} as const;

describe("schemas", () => {
	it("accepts valid account record", () => {
		const now = new Date().toISOString();
		expect(
			accountRecordSchema.parse({
				id: "acct-1",
				label: "Primary",
				emailAddress: "you@example.com",
				providerKind: "gmail",
				syncEnabled: true,
				syncStatus: "idle",
				sourceTruth: "corpus_mirror",
				selectedMailbox: "[Gmail]/All Mail",
				lastSyncedAt: null,
				lastError: null,
				createdAt: now,
				updatedAt: now,
			}),
		).toMatchObject({ id: "acct-1", providerKind: "gmail" });
	});

	it("validates moderation payloads", () => {
		expect(
			messageModerationSchema.parse({
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
					explicitSexual: 0,
					suggestiveSexual: 0,
					nudity: 0,
					sexualMinors: 0,
					adultCommercial: 0,
					overall: 0,
				},
				explanation: "Safe.",
			}),
		).toMatchObject({ nsfw: false });

		expect(() =>
			messageModerationSchema.parse({
				schemaVersion: "message-moderation.v1",
				nsfw: false,
				categories: {},
				scores: {},
				explanation: "",
			}),
		).toThrow();
	});

	it("accepts valid labels and rejects invalid ones", () => {
		expect(messageLabelSchema.parse(validLabel)).toMatchObject({
			routing: { primaryBucket: "finance" },
		});

		expect(() =>
			messageLabelSchema.parse({
				...validLabel,
				routing: {
					primaryBucket: "unknown",
					tags: [],
				},
			}),
		).toThrow();
	});

	it("validates review override input", () => {
		expect(
			resolveReviewInputSchema.parse({
				reviewId: "review-1",
				action: "override",
				override: validLabel,
				note: "Manual fix",
			}),
		).toMatchObject({ action: "override" });

		expect(() =>
			resolveReviewInputSchema.parse({
				reviewId: "review-1",
				action: "override",
				override: {
					schemaVersion: "message-label.v1",
				},
			}),
		).toThrow();
	});
});
