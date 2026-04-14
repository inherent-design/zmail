import { z } from "zod";

export const providerKindSchema = z.enum(["gmail"]);
export const syncStatusSchema = z.enum([
	"idle",
	"syncing",
	"backfilling",
	"needs_reconnect",
	"resync_required",
	"paused",
	"error",
]);
export const watcherStatusSchema = z.enum([
	"stopped",
	"connecting",
	"idle",
	"polling",
	"error",
]);
export const messageSourceStateSchema = z.enum(["active", "tombstoned"]);

export const accountRecordSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	emailAddress: z.string().email(),
	providerKind: providerKindSchema,
	syncEnabled: z.boolean(),
	syncStatus: syncStatusSchema,
	sourceTruth: z.literal("corpus_mirror"),
	selectedMailbox: z.string().min(1),
	lastSyncedAt: z.string().nullable(),
	lastError: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type AccountRecord = z.infer<typeof accountRecordSchema>;

export const accountSyncStateSchema = z.object({
	accountId: z.string().min(1),
	uidvalidity: z.number().int().nullable(),
	latestUidCursor: z.number().int().nullable(),
	earliestUidCursor: z.number().int().nullable(),
	backfillSnapshotUid: z.number().int().nullable(),
	backfillNextUid: z.number().int().nullable(),
	lastBootstrapStartedAt: z.string().nullable(),
	lastBootstrapCompletedAt: z.string().nullable(),
	lastDeltaSyncAt: z.string().nullable(),
	lastReconcileAt: z.string().nullable(),
	lastBackfillSyncAt: z.string().nullable(),
	backfillCompletedAt: z.string().nullable(),
	lastIdleStartedAt: z.string().nullable(),
	lastIdleHeartbeatAt: z.string().nullable(),
	watcherStatus: watcherStatusSchema,
	consecutiveFailures: z.number().int().nonnegative(),
	backoffUntil: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type AccountSyncState = z.infer<typeof accountSyncStateSchema>;

export const messageSourceRecordSchema = z.object({
	id: z.string().min(1),
	messageId: z.string().min(1),
	accountId: z.string().min(1),
	remoteMessageId: z.string().nullable(),
	remoteThreadId: z.string().nullable(),
	mailbox: z.string().nullable(),
	imapUid: z.number().int().nullable(),
	uidvalidity: z.number().int().nullable(),
	rawRfc822Path: z.string().nullable(),
	rawSha256: z.string().nullable(),
	state: messageSourceStateSchema,
	firstSeenAt: z.string(),
	lastSeenAt: z.string(),
	tombstonedAt: z.string().nullable(),
	updatedAt: z.string(),
});

export type MessageSourceRecord = z.infer<typeof messageSourceRecordSchema>;

export const googleOAuthRecordSchema = z.object({
	version: z.literal(1),
	provider: z.literal("google"),
	emailAddress: z.string().email(),
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.string(),
	scope: z.array(z.string()),
	tokenType: z.string(),
	updatedAt: z.string(),
});

export type GoogleOAuthRecord = z.infer<typeof googleOAuthRecordSchema>;

export const messageModerationSchema = z.object({
	schemaVersion: z.literal("message-moderation.v1"),
	nsfw: z.boolean(),
	categories: z.object({
		explicitSexual: z.boolean(),
		suggestiveSexual: z.boolean(),
		nudity: z.boolean(),
		sexualMinors: z.boolean(),
		adultCommercial: z.boolean(),
	}),
	scores: z.object({
		explicitSexual: z.number().min(0).max(1),
		suggestiveSexual: z.number().min(0).max(1),
		nudity: z.number().min(0).max(1),
		sexualMinors: z.number().min(0).max(1),
		adultCommercial: z.number().min(0).max(1),
		overall: z.number().min(0).max(1),
	}),
	explanation: z.string().min(1).max(240),
});

export type MessageModerationV1 = z.infer<typeof messageModerationSchema>;

export const financeSchema = z.object({
	relevant: z.boolean(),
	direction: z.enum(["expense", "income", "both", "neither", "unknown"]),
	owner: z.enum(["personal", "business", "mixed", "unknown"]),
	accountHint: z.string().nullable(),
	purpose: z.string().nullable(),
});

export const socialSchema = z.object({
	personal: z.boolean(),
	private: z.boolean(),
	social: z.boolean(),
	business: z.boolean(),
});

export const riskSchema = z.object({
	businessSensitive: z.boolean(),
	leakRisk: z.boolean(),
});

export const confidenceSchema = z.object({
	overall: z.number().min(0).max(1),
	finance: z.number().min(0).max(1),
	social: z.number().min(0).max(1),
	risk: z.number().min(0).max(1),
});

export const routingSchema = z.object({
	primaryBucket: z.enum(["finance", "nsfw", "personal", "business", "other"]),
	tags: z.array(z.string().min(1)).max(5),
});

export const messageLabelCoreSchema = z.object({
	finance: financeSchema,
	social: socialSchema,
	risk: riskSchema,
	routing: routingSchema,
	confidence: confidenceSchema,
	explanation: z.string().min(1).max(240),
});

export const messageLabelSchema = messageLabelCoreSchema.extend({
	schemaVersion: z.literal("message-label.v1"),
	nsfw: z.boolean(),
});

export const messageLabelWithoutNsfwSchema = messageLabelCoreSchema;

export type MessageLabelV1 = z.infer<typeof messageLabelSchema>;
export type MessageLabelWithoutNsfw = z.infer<
	typeof messageLabelWithoutNsfwSchema
>;

export const overseerProfileSchema = z.object({
	schemaVersion: z.literal("overseer-profile.v1"),
	accountId: z.string().min(1),
	builtFromMessages: z.number().int().nonnegative(),
	knownBusinessDomains: z.array(z.string().min(1)),
	knownPersonalDomains: z.array(z.string().min(1)),
	knownFinancialSenders: z.array(z.string().min(1)),
	recurringPurposeHints: z.array(z.string().min(1)),
	confidentialityPatterns: z.array(z.string().min(1)),
	promotedTags: z.array(z.string().min(1)),
	promptPreamble: z.string().min(1),
});

export type OverseerProfileV1 = z.infer<typeof overseerProfileSchema>;

export const enqueueOverseerInputSchema = z.object({
	accountId: z.string().min(1),
});

export const classifyOneInputSchema = z.object({
	messageId: z.string().min(1),
});

export const resolveReviewInputSchema = z.object({
	reviewId: z.string().min(1),
	action: z.enum(["accept", "override"]),
	override: messageLabelSchema.optional(),
	note: z.string().max(1000).optional(),
});

export const beginGoogleConnectInputSchema = z.object({
	label: z.string().min(1),
});

export const completeGoogleConnectInputSchema = z.object({
	code: z.string().min(1),
	state: z.string().min(1),
});

export const accountIdInputSchema = z.object({
	accountId: z.string().min(1),
});

export const messageLabelNoNsfwJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"finance",
		"social",
		"risk",
		"routing",
		"confidence",
		"explanation",
	],
	properties: {
		finance: {
			type: "object",
			additionalProperties: false,
			required: ["relevant", "direction", "owner", "accountHint", "purpose"],
			properties: {
				relevant: { type: "boolean" },
				direction: {
					type: "string",
					enum: ["expense", "income", "both", "neither", "unknown"],
				},
				owner: {
					type: "string",
					enum: ["personal", "business", "mixed", "unknown"],
				},
				accountHint: { type: ["string", "null"] },
				purpose: { type: ["string", "null"] },
			},
		},
		social: {
			type: "object",
			additionalProperties: false,
			required: ["personal", "private", "social", "business"],
			properties: {
				personal: { type: "boolean" },
				private: { type: "boolean" },
				social: { type: "boolean" },
				business: { type: "boolean" },
			},
		},
		risk: {
			type: "object",
			additionalProperties: false,
			required: ["businessSensitive", "leakRisk"],
			properties: {
				businessSensitive: { type: "boolean" },
				leakRisk: { type: "boolean" },
			},
		},
		routing: {
			type: "object",
			additionalProperties: false,
			required: ["primaryBucket", "tags"],
			properties: {
				primaryBucket: {
					type: "string",
					enum: ["finance", "nsfw", "personal", "business", "other"],
				},
				tags: {
					type: "array",
					items: { type: "string" },
					maxItems: 5,
				},
			},
		},
		confidence: {
			type: "object",
			additionalProperties: false,
			required: ["overall", "finance", "social", "risk"],
			properties: {
				overall: { type: "number", minimum: 0, maximum: 1 },
				finance: { type: "number", minimum: 0, maximum: 1 },
				social: { type: "number", minimum: 0, maximum: 1 },
				risk: { type: "number", minimum: 0, maximum: 1 },
			},
		},
		explanation: { type: "string" },
	},
} as const;

export const overseerProfileJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"accountId",
		"builtFromMessages",
		"knownBusinessDomains",
		"knownPersonalDomains",
		"knownFinancialSenders",
		"recurringPurposeHints",
		"confidentialityPatterns",
		"promotedTags",
		"promptPreamble",
	],
	properties: {
		schemaVersion: {
			type: "string",
			enum: ["overseer-profile.v1"],
		},
		accountId: { type: "string" },
		builtFromMessages: { type: "integer", minimum: 0 },
		knownBusinessDomains: {
			type: "array",
			items: { type: "string" },
		},
		knownPersonalDomains: {
			type: "array",
			items: { type: "string" },
		},
		knownFinancialSenders: {
			type: "array",
			items: { type: "string" },
		},
		recurringPurposeHints: {
			type: "array",
			items: { type: "string" },
		},
		confidentialityPatterns: {
			type: "array",
			items: { type: "string" },
		},
		promotedTags: {
			type: "array",
			items: { type: "string" },
		},
		promptPreamble: { type: "string" },
	},
} as const;
