import { z } from "zod";

export const providerKindSchema = z.enum(["gmail"]);
export const accountConnectionStateSchema = z.enum([
	"connected",
	"config_error",
	"paused",
	"needs_reconnect",
	"disconnected",
]);
export type AccountConnectionState = z.infer<
	typeof accountConnectionStateSchema
>;
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

export const financeDirectionSchema = z.enum([
	"expense",
	"income",
	"both",
	"neither",
	"unknown",
]);

export const financeOwnerSchema = z.enum([
	"personal",
	"business",
	"mixed",
	"unknown",
]);
export const financeBookScopeSchema = financeOwnerSchema;
export type FinanceBookScope = z.infer<typeof financeBookScopeSchema>;

export const rootPrimaryBucketSchema = z.enum([
	"finance",
	"work",
	"relationships",
	"knowledge",
	"assets",
	"entertainment",
	"system",
	"other",
]);
export type RootPrimaryBucket = z.infer<typeof rootPrimaryBucketSchema>;

export const rootSecondaryBucketSchema = z.enum([
	"gaming",
	"networking",
	"community",
	"recruiting",
	"courses",
	"resources",
	"documentation",
	"newsletter",
	"receipt",
	"invoice",
	"statement",
	"subscription",
	"promotion",
	"travel",
	"shopping",
	"tax",
	"banking",
	"payroll",
	"donation",
	"legal",
	"security",
	"ops",
]);
export type RootSecondaryBucket = z.infer<typeof rootSecondaryBucketSchema>;

export const financeSchema = z.object({
	relevant: z.boolean(),
	direction: financeDirectionSchema,
	owner: financeOwnerSchema,
	accountHint: z.string().nullable(),
	purpose: z.string().nullable(),
});

export const financeGateSignalSchema = z.enum([
	"none",
	"receipt",
	"invoice",
	"statement",
	"banking",
	"tax",
	"payroll",
	"investment",
	"subscription",
	"donation",
	"transfer",
	"promotion",
	"other",
]);

export const financeGateSchema = z.object({
	relevant: z.boolean(),
	signal: financeGateSignalSchema,
	operational: z.boolean(),
	bookHint: financeBookScopeSchema,
	requiresFinanceIntel: z.boolean(),
	confidence: z.number().min(0).max(1),
	evidence: z.string().min(1).max(500).nullable(),
});

export const socialSchema = z.object({
	personal: z.boolean(),
	private: z.boolean(),
	social: z.boolean(),
	business: z.boolean(),
});

export const peopleSchema = z.object({
	personal: z.boolean(),
	private: z.boolean(),
	networking: z.boolean(),
	community: z.boolean(),
	recruiting: z.boolean(),
	business: z.boolean(),
});

export const commerceSchema = z.object({
	transactional: z.boolean(),
	shopping: z.boolean(),
	subscription: z.boolean(),
	travel: z.boolean(),
	legal: z.boolean(),
});

export const knowledgeSchema = z.object({
	course: z.boolean(),
	resource: z.boolean(),
	documentation: z.boolean(),
	newsletter: z.boolean(),
	research: z.boolean(),
});

export const assetsSchema = z.object({
	license: z.boolean(),
	credential: z.boolean(),
	account: z.boolean(),
	document: z.boolean(),
});

export const entertainmentSchema = z.object({
	gaming: z.boolean(),
	media: z.boolean(),
	fandom: z.boolean(),
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

export const messageLabelV1CoreSchema = z.object({
	finance: financeSchema,
	social: socialSchema,
	risk: riskSchema,
	routing: routingSchema,
	confidence: confidenceSchema,
	explanation: z.string().min(1).max(240),
});

export const messageLabelV1Schema = messageLabelV1CoreSchema.extend({
	schemaVersion: z.literal("message-label.v1"),
	nsfw: z.boolean(),
});

export const messageLabelWithoutNsfwV1Schema = messageLabelV1CoreSchema;

export type MessageLabelV1 = z.infer<typeof messageLabelV1Schema>;
export type MessageLabelWithoutNsfwV1 = z.infer<
	typeof messageLabelWithoutNsfwV1Schema
>;

export const messageLabelV2ConfidenceSchema = z.object({
	overall: z.number().min(0).max(1),
	finance: z.number().min(0).max(1),
	people: z.number().min(0).max(1),
	commerce: z.number().min(0).max(1),
	knowledge: z.number().min(0).max(1),
	assets: z.number().min(0).max(1),
	entertainment: z.number().min(0).max(1),
	risk: z.number().min(0).max(1),
});

export const messageLabelV2RoutingSchema = z.object({
	primaryBucket: rootPrimaryBucketSchema,
	secondaryBuckets: z.array(rootSecondaryBucketSchema).max(8),
	tags: z.array(z.string().min(1)).max(8),
});

export const messageLabelV2CoreSchema = z.object({
	finance: financeSchema,
	people: peopleSchema,
	commerce: commerceSchema,
	knowledge: knowledgeSchema,
	assets: assetsSchema,
	entertainment: entertainmentSchema,
	risk: riskSchema,
	routing: messageLabelV2RoutingSchema,
	confidence: messageLabelV2ConfidenceSchema,
	explanation: z.string().min(1).max(320),
});

export const messageLabelV2Schema = messageLabelV2CoreSchema.extend({
	schemaVersion: z.literal("message-label.v2"),
	nsfw: z.boolean(),
});

export const messageLabelV3CoreSchema = messageLabelV2CoreSchema
	.omit({ finance: true })
	.extend({
		finance: financeGateSchema,
	});

export const messageLabelV3Schema = messageLabelV3CoreSchema.extend({
	schemaVersion: z.literal("message-label.v3"),
	nsfw: z.boolean(),
});

export const messageLabelWithoutNsfwV2Schema = messageLabelV2CoreSchema;
export const messageLabelWithoutNsfwSchema = messageLabelV3CoreSchema;
export const messageLabelWithoutNsfwV3Schema = messageLabelV3CoreSchema;
export const messageLabelSchema = z.union([
	messageLabelV1Schema,
	messageLabelV2Schema,
	messageLabelV3Schema,
]);

export type MessageLabelV2 = z.infer<typeof messageLabelV2Schema>;
export type MessageLabelV3 = z.infer<typeof messageLabelV3Schema>;
export type MessageLabel = z.infer<typeof messageLabelSchema>;
export type MessageLabelWithoutNsfw = z.infer<
	typeof messageLabelWithoutNsfwSchema
>;
export type MessageLabelWithoutNsfwV2 = z.infer<
	typeof messageLabelWithoutNsfwV2Schema
>;
export type MessageLabelWithoutNsfwV3 = z.infer<
	typeof messageLabelWithoutNsfwV3Schema
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

export const secondaryClassifierKeySchema = z.enum(["finance_intel"]);
export type SecondaryClassifierKey = z.infer<
	typeof secondaryClassifierKeySchema
>;

export const secondaryHeadStatusSchema = z.enum([
	"ready",
	"blocked_parse_error",
	"stale",
	"review",
]);
export type SecondaryHeadStatus = z.infer<typeof secondaryHeadStatusSchema>;

export const reviewClassifierTargetKindSchema = z.enum([
	"root_review",
	"finance_ledger_entry",
]);
export type ReviewClassifierTargetKind = z.infer<
	typeof reviewClassifierTargetKindSchema
>;

export const reviewClassifierSeveritySchema = z.enum([
	"info",
	"low",
	"medium",
	"high",
	"critical",
]);

export const reviewClassifierActionSchema = z.enum([
	"no_action",
	"needs_manual_review",
	"enqueue_root_reclassify",
	"enqueue_finance_reclassify",
	"mapping_needed",
	"overseer_signal",
]);

export const reviewClassifierFindingSchema = z.object({
	targetKind: reviewClassifierTargetKindSchema,
	targetId: z.string().min(1).max(240),
	severity: reviewClassifierSeveritySchema,
	action: reviewClassifierActionSchema,
	confidence: z.number().min(0).max(1),
	reason: z.string().min(1).max(800),
	evidenceRefs: z.array(z.string().min(1).max(240)).max(20),
});

export const reviewClassifierTargetedReclassificationSchema = z.object({
	classifier: z.enum(["root", "finance"]),
	messageIds: z.array(z.string().min(1).max(240)).max(100),
	reason: z.string().min(1).max(500),
});

export const reviewClassifierSchema = z.object({
	schemaVersion: z.literal("review-classifier.v1"),
	summary: z.string().min(1).max(1200),
	findings: z.array(reviewClassifierFindingSchema).max(100),
	targetedReclassification: z
		.array(reviewClassifierTargetedReclassificationSchema)
		.max(20),
	mappingSuggestionRefs: z.array(z.string().min(1).max(240)).max(50),
	overseerSignals: z.array(z.string().min(1).max(500)).max(50),
});
export type ReviewClassifierV1 = z.infer<typeof reviewClassifierSchema>;

export const financeMessageKindSchema = z.enum([
	"receipt",
	"invoice",
	"statement",
	"order_confirmation",
	"billing_notice",
	"subscription_billing",
	"bank_alert",
	"transfer_confirmation",
	"payroll",
	"tax_document",
	"tax_notice",
	"investment_update",
	"donation_receipt",
	"finance_promotion",
	"other_finance",
]);
export type FinanceMessageKind = z.infer<typeof financeMessageKindSchema>;

export const financeActionabilitySchema = z.enum([
	"none",
	"capture_document",
	"create_transaction_candidate",
	"update_registry_hint",
	"manual_review",
]);
export type FinanceActionability = z.infer<typeof financeActionabilitySchema>;

export const financePrimaryCategorySchema = z.enum([
	"income",
	"housing",
	"utilities",
	"banking_fees",
	"transfers",
	"taxes",
	"insurance",
	"healthcare",
	"travel",
	"meals",
	"shopping",
	"software_services",
	"education",
	"office_business",
	"payroll_contractors",
	"investments",
	"donations",
	"subscriptions",
	"uncategorized",
]);
export type FinancePrimaryCategory = z.infer<
	typeof financePrimaryCategorySchema
>;

export const financeMatchedRegistryRefsSchema = z.object({
	identityIds: z.array(z.string().min(1)),
	institutionIds: z.array(z.string().min(1)),
	financialAccountIds: z.array(z.string().min(1)),
});

export const financeUnresolvedEntityHintsSchema = z.object({
	identityHints: z.array(z.string().min(1)),
	institutionHints: z.array(z.string().min(1)),
	financialAccountHints: z.array(z.string().min(1)),
});

export const financeTransactionCandidateV1Schema = z.object({
	kind: z.string().min(1).max(80),
	direction: financeDirectionSchema,
	amount: z.string().min(1).max(64).nullable(),
	currency: z.string().min(1).max(16).nullable(),
	occurredAt: z.string().min(1).max(64).nullable(),
	merchantOrCounterparty: z.string().min(1).max(240).nullable(),
	ownerIdentityRef: z.string().min(1).max(120).nullable(),
	financialAccountRef: z.string().min(1).max(120).nullable(),
	institutionRef: z.string().min(1).max(120).nullable(),
	categoryHint: z.string().min(1).max(120).nullable(),
	taxRelevanceHint: z.string().min(1).max(240).nullable(),
	evidence: z.string().min(1).max(500),
});

export const financeDocumentCandidateV1Schema = z.object({
	documentType: z.string().min(1).max(80),
	issuer: z.string().min(1).max(240).nullable(),
	externalId: z.string().min(1).max(160).nullable(),
	statementPeriodStart: z.string().min(1).max(64).nullable(),
	statementPeriodEnd: z.string().min(1).max(64).nullable(),
	dueAt: z.string().min(1).max(64).nullable(),
	taxYear: z.number().int().min(1900).max(2500).nullable(),
	attachmentRefs: z.array(z.string().min(1)).max(20),
	evidence: z.string().min(1).max(500),
});

export const financeTransactionCandidateSchema =
	financeTransactionCandidateV1Schema
		.omit({
			categoryHint: true,
		})
		.extend({
			categoryPrimary: financePrimaryCategorySchema.nullable(),
			categorySecondary: z.string().min(1).max(120).nullable(),
			statementRefHint: z.string().min(1).max(160).nullable(),
			taxRelevanceHint: z.string().min(1).max(240).nullable(),
		});

export const financeDocumentCandidateSchema =
	financeDocumentCandidateV1Schema.extend({
		accountRefHint: z.string().min(1).max(160).nullable(),
		institutionRefHint: z.string().min(1).max(160).nullable(),
	});

export const financeIntelConfidenceSchema = z.object({
	overall: z.number().min(0).max(1),
	messageKind: z.number().min(0).max(1),
	transactionExtraction: z.number().min(0).max(1),
	registryMatching: z.number().min(0).max(1),
});

export const financeFieldConfidenceSchema = z.object({
	amount: z.number().min(0).max(1).nullable(),
	date: z.number().min(0).max(1).nullable(),
	counterparty: z.number().min(0).max(1).nullable(),
	accountMapping: z.number().min(0).max(1).nullable(),
	book: z.number().min(0).max(1).nullable(),
	category: z.number().min(0).max(1).nullable(),
	dedupe: z.number().min(0).max(1).nullable(),
});

export const financeBookClassificationSchema = z
	.object({
		scope: financeBookScopeSchema,
		businessUsePercent: z.number().min(0).max(100).nullable(),
		taxTreatmentHint: z.string().min(1).max(240).nullable(),
		evidence: z.string().min(1).max(500).nullable(),
	})
	.superRefine((book, context) => {
		if (book.scope === "mixed" && book.businessUsePercent === null) {
			context.addIssue({
				code: "custom",
				message: "mixed book requires businessUsePercent",
				path: ["businessUsePercent"],
			});
		}
	});

export const financeLedgerReadinessStatusSchema = z.enum([
	"exportable",
	"review",
	"blocked",
	"not_ledger",
]);

export const financeLedgerReadinessSchema = z.object({
	status: financeLedgerReadinessStatusSchema,
	reasons: z.array(z.string().min(1).max(160)).max(12),
	requiredFixes: z.array(z.string().min(1).max(80)).max(12),
});

export const beancountAccountMappingHintSchema = z.object({
	debitAccount: z.string().min(1).max(240).nullable(),
	creditAccount: z.string().min(1).max(240).nullable(),
	currency: z.string().min(1).max(16).nullable(),
	mappingKey: z.string().min(1).max(240).nullable(),
	confidence: z.number().min(0).max(1),
	metadata: z.record(z.string(), z.unknown()).default({}),
});

export const financeDedupeInputsSchema = z.object({
	externalTransactionId: z.string().min(1).max(240).nullable(),
	statementRowId: z.string().min(1).max(240).nullable(),
	normalizedComposite: z.string().min(1).max(500).nullable(),
	emailEvidenceKey: z.string().min(1).max(500).nullable(),
});

export const financeTransactionCandidateV3Schema =
	financeTransactionCandidateSchema
		.extend({
			externalTransactionId: z.string().min(1).max(240).nullable(),
			postedAt: z.string().min(1).max(64).nullable(),
			clearedAt: z.string().min(1).max(64).nullable(),
			book: financeBookScopeSchema,
			businessUsePercent: z.number().min(0).max(100).nullable(),
			fieldConfidence: financeFieldConfidenceSchema,
			dedupe: financeDedupeInputsSchema,
			beancount: beancountAccountMappingHintSchema,
		})
		.superRefine((candidate, context) => {
			if (candidate.book === "mixed" && candidate.businessUsePercent === null) {
				context.addIssue({
					code: "custom",
					message: "mixed book transaction requires businessUsePercent",
					path: ["businessUsePercent"],
				});
			}
		});

export const financeDocumentCandidateV3Schema =
	financeDocumentCandidateSchema.extend({
		sourceDocumentRefs: z.array(z.string().min(1).max(240)).max(20),
		statementOpeningBalance: z.string().min(1).max(64).nullable(),
		statementClosingBalance: z.string().min(1).max(64).nullable(),
		statementTransactionCount: z.number().int().nonnegative().nullable(),
		statementCurrency: z.string().min(1).max(16).nullable(),
		book: financeBookScopeSchema,
		fieldConfidence: financeFieldConfidenceSchema,
	});

export const financeIntelV1Schema = z.object({
	schemaVersion: z.literal("finance-intel.v1"),
	messageKind: financeMessageKindSchema,
	actionability: financeActionabilitySchema,
	transactionCandidates: z.array(financeTransactionCandidateV1Schema).max(10),
	documentCandidates: z.array(financeDocumentCandidateV1Schema).max(10),
	matchedRegistryRefs: financeMatchedRegistryRefsSchema,
	unresolvedEntityHints: financeUnresolvedEntityHintsSchema,
	confidence: financeIntelConfidenceSchema,
	explanation: z.string().min(1).max(400),
});

export const financeIntelV2Schema = z.object({
	schemaVersion: z.literal("finance-intel.v2"),
	messageKind: financeMessageKindSchema,
	actionability: financeActionabilitySchema,
	transactionCandidates: z.array(financeTransactionCandidateSchema).max(10),
	documentCandidates: z.array(financeDocumentCandidateSchema).max(10),
	matchedRegistryRefs: financeMatchedRegistryRefsSchema,
	unresolvedEntityHints: financeUnresolvedEntityHintsSchema,
	confidence: financeIntelConfidenceSchema,
	explanation: z.string().min(1).max(400),
});

export const financeIntelV3Schema = z.object({
	schemaVersion: z.literal("finance-intel.v3"),
	messageKind: financeMessageKindSchema,
	actionability: financeActionabilitySchema,
	book: financeBookClassificationSchema,
	ledgerReadiness: financeLedgerReadinessSchema,
	transactionCandidates: z.array(financeTransactionCandidateV3Schema).max(20),
	documentCandidates: z.array(financeDocumentCandidateV3Schema).max(20),
	matchedRegistryRefs: financeMatchedRegistryRefsSchema,
	unresolvedEntityHints: financeUnresolvedEntityHintsSchema,
	dedupe: z.object({
		messageEvidenceKey: z.string().min(1).max(500).nullable(),
		sourceDocumentRefs: z.array(z.string().min(1).max(240)).max(20),
		externalTransactionIds: z.array(z.string().min(1).max(240)).max(50),
		normalizedComposites: z.array(z.string().min(1).max(500)).max(50),
	}),
	fieldConfidence: financeFieldConfidenceSchema,
	confidence: financeIntelConfidenceSchema,
	explanation: z.string().min(1).max(500),
});

export const financeIntelSchema = z.union([
	financeIntelV1Schema,
	financeIntelV2Schema,
	financeIntelV3Schema,
]);

export type FinanceIntelV1 = z.infer<typeof financeIntelV1Schema>;
export type FinanceIntelV2 = z.infer<typeof financeIntelV2Schema>;
export type FinanceIntelV3 = z.infer<typeof financeIntelV3Schema>;
export type FinanceIntel = z.infer<typeof financeIntelSchema>;

export const registryIdentitySchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["personal", "business"]),
	displayName: z.string().min(1),
	aliases: z.array(z.string().min(1)).default([]),
	emailAddresses: z.array(z.string().email()).default([]),
	domains: z.array(z.string().min(1)).default([]),
	taxOwnerHint: z.string().min(1).nullable().default(null),
	notes: z.string().min(1).nullable().default(null),
});
export type RegistryIdentity = z.infer<typeof registryIdentitySchema>;

export const registryInstitutionSchema = z.object({
	id: z.string().min(1),
	displayName: z.string().min(1),
	aliases: z.array(z.string().min(1)).default([]),
	domains: z.array(z.string().min(1)).default([]),
	notes: z.string().min(1).nullable().default(null),
});
export type RegistryInstitution = z.infer<typeof registryInstitutionSchema>;

export const registryFinancialAccountSchema = z.object({
	id: z.string().min(1),
	institutionId: z.string().min(1).nullable().default(null),
	ownerIdentityId: z.string().min(1).nullable().default(null),
	displayName: z.string().min(1),
	aliases: z.array(z.string().min(1)).default([]),
	accountMask: z.string().min(1).nullable().default(null),
	accountLast4: z
		.string()
		.regex(/^[0-9]{4}$/)
		.nullable()
		.default(null),
	accountType: z.string().min(1).nullable().default(null),
	currency: z.string().min(1).nullable().default(null),
	taxOwnerHint: z.string().min(1).nullable().default(null),
	notes: z.string().min(1).nullable().default(null),
});
export type RegistryFinancialAccount = z.infer<
	typeof registryFinancialAccountSchema
>;

export const registrySenderRuleSchema = z.object({
	id: z.string().min(1),
	senderPattern: z.string().min(1),
	domain: z.string().min(1).nullable().default(null),
	ownerIdentityId: z.string().min(1).nullable().default(null),
	institutionId: z.string().min(1).nullable().default(null),
	financialAccountId: z.string().min(1).nullable().default(null),
	messageKindHint: financeMessageKindSchema.nullable().default(null),
	priority: z.number().int().min(0).default(100),
	notes: z.string().min(1).nullable().default(null),
});
export type RegistrySenderRule = z.infer<typeof registrySenderRuleSchema>;

export const financeAccountMappingSchema = z.object({
	mappingKey: z.string().min(1).max(240),
	book: financeBookScopeSchema.default("unknown"),
	match: z.record(z.string(), z.unknown()).default({}),
	debitAccount: z.string().min(1).max(240).nullable().default(null),
	creditAccount: z.string().min(1).max(240).nullable().default(null),
	currency: z.string().min(1).max(16).nullable().default(null),
	confidence: z.number().min(0).max(1).default(0.75),
	notes: z.string().min(1).max(1000).nullable().default(null),
});
export type FinanceAccountMapping = z.infer<typeof financeAccountMappingSchema>;

export const financeAccountMappingSuggestionSchema = z.object({
	schemaVersion: z.literal("finance-account-mapping-suggestion.v1"),
	mapping: financeAccountMappingSchema,
	impact: z.object({
		ledgerEntryIds: z.array(z.string().min(1)).default([]),
		ledgerCanonicalKeys: z.array(z.string().min(1)).default([]),
		rowCount: z.number().int().nonnegative(),
		readyUnlockEstimate: z.number().int().nonnegative(),
		totalMinorByDirection: z.object({
			expense: z.number().int().default(0),
			income: z.number().int().default(0),
			both: z.number().int().default(0),
			neither: z.number().int().default(0),
			unknown: z.number().int().default(0),
		}),
	}),
	evidence: z.object({
		senderDomains: z.array(z.string().min(1)).default([]),
		counterparties: z.array(z.string().min(1)).default([]),
		books: z.array(financeBookScopeSchema).default([]),
		categories: z.array(z.string().min(1)).default([]),
		accounts: z.array(z.string().min(1)).default([]),
		sampleMessageIds: z.array(z.string().min(1)).default([]),
	}),
	dedupe: z.object({
		clusterKey: z.string().min(1).max(500),
		duplicateCanonicalKeys: z.array(z.string().min(1)).default([]),
		confidenceReasons: z.array(z.string().min(1)).default([]),
	}),
	autoApplyEligible: z.boolean(),
});
export type FinanceAccountMappingSuggestion = z.infer<
	typeof financeAccountMappingSuggestionSchema
>;

export const registryIdentityFileSchema = z.array(registryIdentitySchema);
export const registryInstitutionFileSchema = z.array(registryInstitutionSchema);
export const registryFinancialAccountFileSchema = z.array(
	registryFinancialAccountSchema,
);
export const registrySenderRuleFileSchema = z.array(registrySenderRuleSchema);
export const financeAccountMappingFileSchema = z.array(
	financeAccountMappingSchema,
);

export const financeMappingUpsertInputSchema = z.object({
	mapping: financeAccountMappingSchema,
});

export const taxPersonalPackageInputSchema = z.object({
	year: z.number().int().min(1900).max(2500),
	outDir: z.string().min(1).max(1000).nullable().optional(),
});

export const taxBusinessQuarterPackageInputSchema = z.object({
	year: z.number().int().min(1900).max(2500),
	quarter: z.number().int().min(1).max(4),
	businessSlug: z.literal("inherent-design").default("inherent-design"),
	outDir: z.string().min(1).max(1000).nullable().optional(),
});

export const financeEventCandidateSchema = z.object({
	id: z.string().min(1),
	canonicalKey: z.string().min(1),
	status: z.string().min(1),
	eventKind: z.string().min(1),
	direction: financeDirectionSchema.nullable(),
	amountValue: z.string().nullable(),
	currency: z.string().nullable(),
	occurredAt: z.string().nullable(),
	merchantOrCounterparty: z.string().nullable(),
	ownerIdentityId: z.string().nullable(),
	financialAccountId: z.string().nullable(),
	institutionId: z.string().nullable(),
	categoryHint: z.string().nullable(),
	taxRelevanceHint: z.string().nullable(),
	evidenceCount: z.number().int().nonnegative(),
	firstMessageReceivedAt: z.string().nullable(),
	lastMessageReceivedAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type FinanceEventCandidate = z.infer<typeof financeEventCandidateSchema>;

export const financeDocumentCandidateRecordSchema = z.object({
	id: z.string().min(1),
	canonicalKey: z.string().min(1),
	status: z.string().min(1),
	documentType: z.string().min(1),
	issuer: z.string().nullable(),
	externalId: z.string().nullable(),
	statementPeriodStart: z.string().nullable(),
	statementPeriodEnd: z.string().nullable(),
	dueAt: z.string().nullable(),
	taxYear: z.number().int().nullable(),
	ownerIdentityId: z.string().nullable(),
	financialAccountId: z.string().nullable(),
	institutionId: z.string().nullable(),
	evidenceCount: z.number().int().nonnegative(),
	firstMessageReceivedAt: z.string().nullable(),
	lastMessageReceivedAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type FinanceDocumentCandidate = z.infer<
	typeof financeDocumentCandidateRecordSchema
>;

export const ruleProjectionSourceSchema = z.enum([
	"root_model",
	"overlay_rule",
	"finance_secondary",
	"pdf_import",
]);
export type RuleProjectionSource = z.infer<typeof ruleProjectionSourceSchema>;

export const rootTaxonomyFileSchema = z.object({
	schemaVersion: z.literal("root-taxonomy.v1"),
	primaryBuckets: z.array(rootPrimaryBucketSchema).min(1),
	secondaryBuckets: z.array(rootSecondaryBucketSchema),
});
export type RootTaxonomyFile = z.infer<typeof rootTaxonomyFileSchema>;

export const financeTaxonomyFileSchema = z.object({
	schemaVersion: z.literal("finance-taxonomy.v1"),
	categories: z.array(
		z.object({
			primary: financePrimaryCategorySchema,
			secondary: z.array(z.string().min(1)).default([]),
		}),
	),
});
export type FinanceTaxonomyFile = z.infer<typeof financeTaxonomyFileSchema>;

export const classificationRuleMatchSchema = z.object({
	senderDomain: z.string().min(1).optional(),
	senderIncludes: z.string().min(1).optional(),
	accountLabel: z.string().min(1).optional(),
	accountEmail: z.string().email().optional(),
	rootPrimaryBucket: rootPrimaryBucketSchema.optional(),
	rootSecondaryBucket: rootSecondaryBucketSchema.optional(),
	rootTag: z.string().min(1).optional(),
	financeMessageKind: financeMessageKindSchema.optional(),
	financeActionability: financeActionabilitySchema.optional(),
	hasAttachmentMimePrefix: z.string().min(1).optional(),
});
export type ClassificationRuleMatch = z.infer<
	typeof classificationRuleMatchSchema
>;

export const classificationRuleProjectionSchema = z.object({
	source: ruleProjectionSourceSchema.default("overlay_rule"),
	primaryCategory: rootPrimaryBucketSchema.optional(),
	secondaryCategory: rootSecondaryBucketSchema.optional(),
	financePrimary: financePrimaryCategorySchema.optional(),
	financeSecondary: z.string().min(1).optional(),
});
export type ClassificationRuleProjection = z.infer<
	typeof classificationRuleProjectionSchema
>;

export const classificationRuleSchema = z.object({
	key: z.string().min(1),
	description: z.string().min(1).optional(),
	priority: z.number().int().min(0).default(100),
	enabled: z.boolean().default(true),
	match: classificationRuleMatchSchema,
	projection: classificationRuleProjectionSchema,
});
export type ClassificationRule = z.infer<typeof classificationRuleSchema>;

export const classificationRulesFileSchema = z.object({
	schemaVersion: z.literal("classification-rules.v1"),
	rules: z.array(classificationRuleSchema),
});
export type ClassificationRulesFile = z.infer<
	typeof classificationRulesFileSchema
>;

const financeImportSourceKindSchema = z.enum([
	"pdf",
	"statement",
	"csv",
	"ofx",
]);
export type FinanceImportSourceKind = z.infer<
	typeof financeImportSourceKindSchema
>;

export const registryIdentitySuggestionSchema = registryIdentitySchema
	.omit({ id: true })
	.extend({
		canonicalKey: z.string().min(1),
		confidence: z.number().min(0).max(1).default(0.75),
	});

export const registryInstitutionSuggestionSchema = registryInstitutionSchema
	.omit({ id: true })
	.extend({
		canonicalKey: z.string().min(1),
		confidence: z.number().min(0).max(1).default(0.75),
	});

export const registryFinancialAccountSuggestionSchema =
	registryFinancialAccountSchema.omit({ id: true }).extend({
		canonicalKey: z.string().min(1),
		confidence: z.number().min(0).max(1).default(0.75),
	});

export const registrySenderRuleSuggestionSchema = registrySenderRuleSchema
	.omit({ id: true })
	.extend({
		canonicalKey: z.string().min(1),
		confidence: z.number().min(0).max(1).default(0.75),
	});

export const financeImportSourceFileSchema = z.object({
	absolutePath: z.string().min(1),
	sha256: z.string().min(1),
	filename: z.string().min(1),
	importedAt: z.string().min(1),
});

export const financeImportExtractorSchema = z.object({
	runner: z.string().min(1),
	model: z.string().min(1),
	promptVersion: z.string().min(1),
	extractedTextHash: z.string().min(1).nullable().default(null),
});

export const financeImportDocumentSchema = z.object({
	sourceDocumentRef: z.string().min(1).nullable().default(null),
	documentType: z.string().min(1).max(80),
	issuer: z.string().min(1).max(240).nullable().default(null),
	externalId: z.string().min(1).max(160).nullable().default(null),
	statementPeriodStart: z.string().min(1).max(64).nullable().default(null),
	statementPeriodEnd: z.string().min(1).max(64).nullable().default(null),
	dueAt: z.string().min(1).max(64).nullable().default(null),
	taxYear: z.number().int().min(1900).max(2500).nullable().default(null),
	ownerIdentityHint: z.string().min(1).nullable().default(null),
	financialAccountHint: z.string().min(1).nullable().default(null),
	institutionHint: z.string().min(1).nullable().default(null),
	evidenceText: z.string().min(1).max(2000),
});
export type FinanceImportDocument = z.infer<typeof financeImportDocumentSchema>;

export const financeImportTransactionSchema = z.object({
	sourceDocumentRef: z.string().min(1).nullable().default(null),
	occurredAt: z.string().min(1).max(64).nullable().default(null),
	postedAt: z.string().min(1).max(64).nullable().default(null),
	amount: z.string().min(1).max(64).nullable().default(null),
	currency: z.string().min(1).max(16).nullable().default(null),
	direction: financeDirectionSchema,
	description: z.string().min(1).max(400).nullable().default(null),
	merchantOrCounterparty: z.string().min(1).max(240).nullable().default(null),
	balance: z.string().min(1).max(64).nullable().default(null),
	ownerIdentityHint: z.string().min(1).nullable().default(null),
	financialAccountHint: z.string().min(1).nullable().default(null),
	institutionHint: z.string().min(1).nullable().default(null),
	categoryPrimary: financePrimaryCategorySchema.nullable().default(null),
	categorySecondary: z.string().min(1).max(120).nullable().default(null),
	evidenceText: z.string().min(1).max(2000),
});
export type FinanceImportTransaction = z.infer<
	typeof financeImportTransactionSchema
>;

export const financeSourceImportV1Schema = z.object({
	schemaVersion: z.literal("finance-source-import.v1"),
	sourceKind: financeImportSourceKindSchema,
	sourceFile: financeImportSourceFileSchema,
	artifactSha256: z.string().min(1),
	extractor: financeImportExtractorSchema,
	registrySuggestions: z.object({
		identities: z.array(registryIdentitySuggestionSchema).default([]),
		institutions: z.array(registryInstitutionSuggestionSchema).default([]),
		financialAccounts: z
			.array(registryFinancialAccountSuggestionSchema)
			.default([]),
		senderRules: z.array(registrySenderRuleSuggestionSchema).default([]),
	}),
	documents: z.array(financeImportDocumentSchema).default([]),
	transactions: z.array(financeImportTransactionSchema).default([]),
	provenance: z.record(z.string(), z.unknown()).default({}),
});
export type FinanceSourceImportV1 = z.infer<typeof financeSourceImportV1Schema>;

export const financeImportDocumentV2Schema = financeImportDocumentSchema.extend(
	{
		statementOpeningBalance: z.string().min(1).max(64).nullable().default(null),
		statementClosingBalance: z.string().min(1).max(64).nullable().default(null),
		statementTransactionCount: z
			.number()
			.int()
			.nonnegative()
			.nullable()
			.default(null),
		statementCurrency: z.string().min(1).max(16).nullable().default(null),
		accountMappingKey: z.string().min(1).max(240).nullable().default(null),
		extractionConfidence: z.number().min(0).max(1).default(0),
		rawPayload: z.record(z.string(), z.unknown()).default({}),
	},
);

export const financeImportTransactionV2Schema =
	financeImportTransactionSchema.extend({
		externalTransactionId: z.string().min(1).max(240).nullable().default(null),
		clearedAt: z.string().min(1).max(64).nullable().default(null),
		statementRowId: z.string().min(1).max(240).nullable().default(null),
		rowIndex: z.number().int().nonnegative().nullable().default(null),
		accountMappingKey: z.string().min(1).max(240).nullable().default(null),
		bookHint: financeBookScopeSchema.default("unknown"),
		businessUsePercent: z.number().min(0).max(100).nullable().default(null),
		extractionConfidence: z.number().min(0).max(1).default(0),
		rowProvenance: z.record(z.string(), z.unknown()).default({}),
		rawPayload: z.record(z.string(), z.unknown()).default({}),
	});

export const financeSourceImportV2Schema = z.object({
	schemaVersion: z.literal("finance-source-import.v2"),
	sourceKind: financeImportSourceKindSchema,
	sourceFile: financeImportSourceFileSchema,
	artifactSha256: z.string().min(1),
	extractor: financeImportExtractorSchema,
	registrySuggestions: z.object({
		identities: z.array(registryIdentitySuggestionSchema).default([]),
		institutions: z.array(registryInstitutionSuggestionSchema).default([]),
		financialAccounts: z
			.array(registryFinancialAccountSuggestionSchema)
			.default([]),
		senderRules: z.array(registrySenderRuleSuggestionSchema).default([]),
	}),
	documents: z.array(financeImportDocumentV2Schema).default([]),
	transactions: z.array(financeImportTransactionV2Schema).default([]),
	provenance: z.record(z.string(), z.unknown()).default({}),
});

export const financeSourceImportSchema = z.union([
	financeSourceImportV1Schema,
	financeSourceImportV2Schema,
]);
export type FinanceSourceImportV2 = z.infer<typeof financeSourceImportV2Schema>;
export type FinanceSourceImport = z.infer<typeof financeSourceImportSchema>;

export const financeLedgerExportItemSchema = z.object({
	canonicalKey: z.string().min(1).max(500),
	status: z.enum(["exported", "unresolved", "blocked"]),
	sourceKind: z.enum(["ledger_entry", "raw_sidecar"]),
	beancountLink: z.string().min(1).max(240).nullable(),
	messageId: z.string().min(1).nullable(),
	sourceImportId: z.string().min(1).nullable(),
	reason: z.string().min(1).max(500).nullable(),
});

export const financeLedgerExportSchema = z.object({
	schemaVersion: z.literal("finance-ledger-export.v1"),
	orgId: z.string().min(1),
	exportRunId: z.string().min(1),
	generatedAt: z.string().min(1),
	strict: z.boolean(),
	year: z.number().int().min(1900).max(2500).nullable(),
	files: z.object({
		main: z.string().min(1),
		accounts: z.string().min(1),
		generated: z.array(z.string().min(1)),
		raw: z.string().min(1),
		unresolved: z.string().min(1),
		documents: z.array(z.string().min(1)),
	}),
	items: z.array(financeLedgerExportItemSchema),
	unresolvedRows: z.array(z.record(z.string(), z.unknown())),
	validation: z.object({
		beanCheck: z.enum(["passed", "failed", "skipped"]),
		beanCheckOutput: z.string().nullable(),
		favaSmoke: z.enum(["manual", "skipped"]),
	}),
});
export type FinanceLedgerExportV1 = z.infer<typeof financeLedgerExportSchema>;

export const financeDataInputSchema = z.object({
	year: z.number().int().min(1900).max(2500).optional(),
	accountId: z.string().min(1).optional(),
	institutionId: z.string().min(1).optional(),
	ownerIdentityId: z.string().min(1).optional(),
	sourceKind: z.enum(["email", "pdf", "statement", "csv", "ofx"]).optional(),
});
export type FinanceDataInput = z.infer<typeof financeDataInputSchema>;

export const financeArtifactImportInputSchema = z.object({
	artifact: financeSourceImportSchema,
});

function uniqueStrings(values: string[]) {
	return Array.from(
		new Set(
			values.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	);
}

function inferSecondaryBucketsFromTags(tags: string[]) {
	return uniqueStrings(tags)
		.map((tag) => rootSecondaryBucketSchema.safeParse(tag))
		.flatMap((result) => (result.success ? [result.data] : []));
}

export function normalizeMessageLabel(input: unknown): MessageLabelV2 | null {
	return normalizeLegacyMessageLabel(input);
}

export function parseCurrentMessageLabel(
	input: unknown,
): MessageLabelV3 | null {
	const direct = messageLabelV3Schema.safeParse(input);
	if (!direct.success) {
		return null;
	}
	return {
		...direct.data,
		routing: {
			...direct.data.routing,
			secondaryBuckets: uniqueStrings(
				direct.data.routing.secondaryBuckets,
			).flatMap((bucket) => {
				const parsed = rootSecondaryBucketSchema.safeParse(bucket);
				return parsed.success ? [parsed.data] : [];
			}),
			tags: uniqueStrings(direct.data.routing.tags),
		},
	};
}

export function normalizeLegacyMessageLabel(
	input: unknown,
): MessageLabelV2 | null {
	const direct = messageLabelV2Schema.safeParse(input);
	if (direct.success) {
		return {
			...direct.data,
			routing: {
				...direct.data.routing,
				secondaryBuckets: uniqueStrings(
					direct.data.routing.secondaryBuckets,
				).flatMap((bucket) => {
					const parsed = rootSecondaryBucketSchema.safeParse(bucket);
					return parsed.success ? [parsed.data] : [];
				}),
				tags: uniqueStrings(direct.data.routing.tags),
			},
		};
	}

	const legacy = messageLabelV1Schema.safeParse(input);
	if (!legacy.success) {
		return null;
	}

	const { data } = legacy;
	const tags = uniqueStrings(data.routing.tags);
	const secondaryBuckets = inferSecondaryBucketsFromTags(tags);
	const primaryBucket: RootPrimaryBucket =
		data.routing.primaryBucket === "finance"
			? "finance"
			: data.routing.primaryBucket === "business"
				? "work"
				: data.routing.primaryBucket === "personal"
					? "relationships"
					: "other";

	return {
		schemaVersion: "message-label.v2",
		nsfw: data.nsfw,
		finance: data.finance,
		people: {
			personal: data.social.personal,
			private: data.social.private,
			networking: secondaryBuckets.includes("networking"),
			community: secondaryBuckets.includes("community"),
			recruiting: secondaryBuckets.includes("recruiting"),
			business: data.social.business,
		},
		commerce: {
			transactional: data.finance.relevant,
			shopping:
				secondaryBuckets.includes("shopping") ||
				secondaryBuckets.includes("receipt") ||
				secondaryBuckets.includes("invoice"),
			subscription: secondaryBuckets.includes("subscription"),
			travel: secondaryBuckets.includes("travel"),
			legal: secondaryBuckets.includes("legal"),
		},
		knowledge: {
			course: secondaryBuckets.includes("courses"),
			resource: secondaryBuckets.includes("resources"),
			documentation: secondaryBuckets.includes("documentation"),
			newsletter: secondaryBuckets.includes("newsletter"),
			research: false,
		},
		assets: {
			license: false,
			credential: false,
			account: data.finance.accountHint !== null,
			document: secondaryBuckets.includes("statement"),
		},
		entertainment: {
			gaming: secondaryBuckets.includes("gaming"),
			media: false,
			fandom: false,
		},
		risk: data.risk,
		routing: {
			primaryBucket,
			secondaryBuckets,
			tags,
		},
		confidence: {
			overall: data.confidence.overall,
			finance: data.confidence.finance,
			people: data.confidence.social,
			commerce: data.confidence.finance,
			knowledge: data.confidence.overall,
			assets: data.confidence.overall,
			entertainment: data.confidence.overall,
			risk: data.confidence.risk,
		},
		explanation: data.explanation,
	};
}

export function normalizeFinanceIntel(input: unknown): FinanceIntelV2 | null {
	return normalizeLegacyFinanceIntel(input);
}

export function parseCurrentFinanceIntel(
	input: unknown,
): FinanceIntelV3 | null {
	const direct = financeIntelV3Schema.safeParse(input);
	return direct.success ? direct.data : null;
}

export function normalizeLegacyFinanceIntel(
	input: unknown,
): FinanceIntelV2 | null {
	const direct = financeIntelV2Schema.safeParse(input);
	if (direct.success) {
		return direct.data;
	}

	const legacy = financeIntelV1Schema.safeParse(input);
	if (!legacy.success) {
		return null;
	}

	const { data } = legacy;
	return {
		schemaVersion: "finance-intel.v2",
		messageKind: data.messageKind,
		actionability: data.actionability,
		transactionCandidates: data.transactionCandidates.map((candidate) => ({
			kind: candidate.kind,
			direction: candidate.direction,
			amount: candidate.amount,
			currency: candidate.currency,
			occurredAt: candidate.occurredAt,
			merchantOrCounterparty: candidate.merchantOrCounterparty,
			ownerIdentityRef: candidate.ownerIdentityRef,
			financialAccountRef: candidate.financialAccountRef,
			institutionRef: candidate.institutionRef,
			categoryPrimary: "uncategorized",
			categorySecondary: candidate.categoryHint,
			statementRefHint: null,
			taxRelevanceHint: candidate.taxRelevanceHint,
			evidence: candidate.evidence,
		})),
		documentCandidates: data.documentCandidates.map((candidate) => ({
			...candidate,
			accountRefHint: null,
			institutionRefHint: candidate.issuer,
		})),
		matchedRegistryRefs: data.matchedRegistryRefs,
		unresolvedEntityHints: data.unresolvedEntityHints,
		confidence: data.confidence,
		explanation: data.explanation,
	};
}

export const enqueueOverseerInputSchema = z.object({
	accountId: z.string().min(1),
});

export const classifyOneInputSchema = z.object({
	messageId: z.string().min(1),
});

export const classifyRootMessagesInputSchema = z.object({
	messageIds: z.array(z.string().min(1)).min(1).max(250),
});

export const classifyReviewBacklogInputSchema = z.object({
	accountId: z.string().min(1).optional(),
	limit: z.number().int().positive().max(500).optional(),
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

export const beginGoogleReconnectInputSchema = z.object({
	accountId: z.string().min(1),
	label: z.string().min(1),
});

export const completeGoogleConnectInputSchema = z.object({
	code: z.string().min(1),
	state: z.string().min(1),
});

export const accountIdInputSchema = z.object({
	accountId: z.string().min(1),
});

export const purgeAccountInputSchema = z.object({
	accountId: z.string().min(1),
	confirmationEmail: z.string().min(1),
});

export const reviewClassifierJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"summary",
		"findings",
		"targetedReclassification",
		"mappingSuggestionRefs",
		"overseerSignals",
	],
	properties: {
		schemaVersion: { type: "string", enum: ["review-classifier.v1"] },
		summary: { type: "string" },
		findings: {
			type: "array",
			maxItems: 100,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"targetKind",
					"targetId",
					"severity",
					"action",
					"confidence",
					"reason",
					"evidenceRefs",
				],
				properties: {
					targetKind: {
						type: "string",
						enum: ["root_review", "finance_ledger_entry"],
					},
					targetId: { type: "string" },
					severity: {
						type: "string",
						enum: ["info", "low", "medium", "high", "critical"],
					},
					action: {
						type: "string",
						enum: [
							"no_action",
							"needs_manual_review",
							"enqueue_root_reclassify",
							"enqueue_finance_reclassify",
							"mapping_needed",
							"overseer_signal",
						],
					},
					confidence: { type: "number", minimum: 0, maximum: 1 },
					reason: { type: "string" },
					evidenceRefs: {
						type: "array",
						maxItems: 20,
						items: { type: "string" },
					},
				},
			},
		},
		targetedReclassification: {
			type: "array",
			maxItems: 20,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["classifier", "messageIds", "reason"],
				properties: {
					classifier: { type: "string", enum: ["root", "finance"] },
					messageIds: {
						type: "array",
						maxItems: 100,
						items: { type: "string" },
					},
					reason: { type: "string" },
				},
			},
		},
		mappingSuggestionRefs: {
			type: "array",
			maxItems: 50,
			items: { type: "string" },
		},
		overseerSignals: {
			type: "array",
			maxItems: 50,
			items: { type: "string" },
		},
	},
} as const;

export const messageLabelNoNsfwJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"finance",
		"people",
		"commerce",
		"knowledge",
		"assets",
		"entertainment",
		"risk",
		"routing",
		"confidence",
		"explanation",
	],
	properties: {
		finance: {
			type: "object",
			additionalProperties: false,
			required: [
				"relevant",
				"signal",
				"operational",
				"bookHint",
				"requiresFinanceIntel",
				"confidence",
				"evidence",
			],
			properties: {
				relevant: { type: "boolean" },
				signal: {
					type: "string",
					enum: [
						"none",
						"receipt",
						"invoice",
						"statement",
						"banking",
						"tax",
						"payroll",
						"investment",
						"subscription",
						"donation",
						"transfer",
						"promotion",
						"other",
					],
				},
				operational: { type: "boolean" },
				bookHint: {
					type: "string",
					enum: ["personal", "business", "mixed", "unknown"],
				},
				requiresFinanceIntel: { type: "boolean" },
				confidence: { type: "number", minimum: 0, maximum: 1 },
				evidence: { type: ["string", "null"] },
			},
		},
		people: {
			type: "object",
			additionalProperties: false,
			required: [
				"personal",
				"private",
				"networking",
				"community",
				"recruiting",
				"business",
			],
			properties: {
				personal: { type: "boolean" },
				private: { type: "boolean" },
				networking: { type: "boolean" },
				community: { type: "boolean" },
				recruiting: { type: "boolean" },
				business: { type: "boolean" },
			},
		},
		commerce: {
			type: "object",
			additionalProperties: false,
			required: [
				"transactional",
				"shopping",
				"subscription",
				"travel",
				"legal",
			],
			properties: {
				transactional: { type: "boolean" },
				shopping: { type: "boolean" },
				subscription: { type: "boolean" },
				travel: { type: "boolean" },
				legal: { type: "boolean" },
			},
		},
		knowledge: {
			type: "object",
			additionalProperties: false,
			required: [
				"course",
				"resource",
				"documentation",
				"newsletter",
				"research",
			],
			properties: {
				course: { type: "boolean" },
				resource: { type: "boolean" },
				documentation: { type: "boolean" },
				newsletter: { type: "boolean" },
				research: { type: "boolean" },
			},
		},
		assets: {
			type: "object",
			additionalProperties: false,
			required: ["license", "credential", "account", "document"],
			properties: {
				license: { type: "boolean" },
				credential: { type: "boolean" },
				account: { type: "boolean" },
				document: { type: "boolean" },
			},
		},
		entertainment: {
			type: "object",
			additionalProperties: false,
			required: ["gaming", "media", "fandom"],
			properties: {
				gaming: { type: "boolean" },
				media: { type: "boolean" },
				fandom: { type: "boolean" },
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
			required: ["primaryBucket", "secondaryBuckets", "tags"],
			properties: {
				primaryBucket: {
					type: "string",
					enum: [
						"finance",
						"work",
						"relationships",
						"knowledge",
						"assets",
						"entertainment",
						"system",
						"other",
					],
				},
				secondaryBuckets: {
					type: "array",
					items: {
						type: "string",
						enum: [
							"gaming",
							"networking",
							"community",
							"recruiting",
							"courses",
							"resources",
							"documentation",
							"newsletter",
							"receipt",
							"invoice",
							"statement",
							"subscription",
							"promotion",
							"travel",
							"shopping",
							"tax",
							"banking",
							"payroll",
							"donation",
							"legal",
							"security",
							"ops",
						],
					},
					maxItems: 8,
				},
				tags: {
					type: "array",
					items: { type: "string" },
					maxItems: 8,
				},
			},
		},
		confidence: {
			type: "object",
			additionalProperties: false,
			required: [
				"overall",
				"finance",
				"people",
				"commerce",
				"knowledge",
				"assets",
				"entertainment",
				"risk",
			],
			properties: {
				overall: { type: "number", minimum: 0, maximum: 1 },
				finance: { type: "number", minimum: 0, maximum: 1 },
				people: { type: "number", minimum: 0, maximum: 1 },
				commerce: { type: "number", minimum: 0, maximum: 1 },
				knowledge: { type: "number", minimum: 0, maximum: 1 },
				assets: { type: "number", minimum: 0, maximum: 1 },
				entertainment: { type: "number", minimum: 0, maximum: 1 },
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

export const financeIntelJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"messageKind",
		"actionability",
		"book",
		"ledgerReadiness",
		"transactionCandidates",
		"documentCandidates",
		"matchedRegistryRefs",
		"unresolvedEntityHints",
		"dedupe",
		"fieldConfidence",
		"confidence",
		"explanation",
	],
	properties: {
		schemaVersion: { type: "string", enum: ["finance-intel.v3"] },
		messageKind: {
			type: "string",
			enum: [
				"receipt",
				"invoice",
				"statement",
				"order_confirmation",
				"billing_notice",
				"subscription_billing",
				"bank_alert",
				"transfer_confirmation",
				"payroll",
				"tax_document",
				"tax_notice",
				"investment_update",
				"donation_receipt",
				"finance_promotion",
				"other_finance",
			],
		},
		actionability: {
			type: "string",
			enum: [
				"none",
				"capture_document",
				"create_transaction_candidate",
				"update_registry_hint",
				"manual_review",
			],
		},
		book: {
			type: "object",
			additionalProperties: false,
			required: ["scope", "businessUsePercent", "taxTreatmentHint", "evidence"],
			properties: {
				scope: {
					type: "string",
					enum: ["personal", "business", "mixed", "unknown"],
				},
				businessUsePercent: {
					type: ["number", "null"],
					minimum: 0,
					maximum: 100,
				},
				taxTreatmentHint: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 240,
				},
				evidence: { type: ["string", "null"], minLength: 1, maxLength: 500 },
			},
		},
		ledgerReadiness: {
			type: "object",
			additionalProperties: false,
			required: ["status", "reasons", "requiredFixes"],
			properties: {
				status: {
					type: "string",
					enum: ["exportable", "review", "blocked", "not_ledger"],
				},
				reasons: {
					type: "array",
					maxItems: 12,
					items: { type: "string", minLength: 1, maxLength: 160 },
				},
				requiredFixes: {
					type: "array",
					maxItems: 12,
					items: { type: "string", minLength: 1, maxLength: 80 },
				},
			},
		},
		transactionCandidates: {
			type: "array",
			maxItems: 20,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"kind",
					"direction",
					"amount",
					"currency",
					"occurredAt",
					"merchantOrCounterparty",
					"ownerIdentityRef",
					"financialAccountRef",
					"institutionRef",
					"categoryPrimary",
					"categorySecondary",
					"statementRefHint",
					"taxRelevanceHint",
					"evidence",
					"externalTransactionId",
					"postedAt",
					"clearedAt",
					"book",
					"businessUsePercent",
					"fieldConfidence",
					"dedupe",
					"beancount",
				],
				properties: {
					kind: { type: "string", minLength: 1, maxLength: 80 },
					direction: {
						type: "string",
						enum: ["expense", "income", "both", "neither", "unknown"],
					},
					amount: { type: ["string", "null"], minLength: 1, maxLength: 64 },
					currency: { type: ["string", "null"], minLength: 1, maxLength: 16 },
					occurredAt: { type: ["string", "null"], minLength: 1, maxLength: 64 },
					merchantOrCounterparty: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 240,
					},
					ownerIdentityRef: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 120,
					},
					financialAccountRef: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 120,
					},
					institutionRef: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 120,
					},
					categoryPrimary: {
						type: ["string", "null"],
						enum: [
							"income",
							"housing",
							"utilities",
							"banking_fees",
							"transfers",
							"taxes",
							"insurance",
							"healthcare",
							"travel",
							"meals",
							"shopping",
							"software_services",
							"education",
							"office_business",
							"payroll_contractors",
							"investments",
							"donations",
							"subscriptions",
							"uncategorized",
							null,
						],
					},
					categorySecondary: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 120,
					},
					statementRefHint: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 160,
					},
					taxRelevanceHint: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 240,
					},
					evidence: { type: "string", minLength: 1, maxLength: 500 },
					externalTransactionId: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 240,
					},
					postedAt: { type: ["string", "null"], minLength: 1, maxLength: 64 },
					clearedAt: { type: ["string", "null"], minLength: 1, maxLength: 64 },
					book: {
						type: "string",
						enum: ["personal", "business", "mixed", "unknown"],
					},
					businessUsePercent: {
						type: ["number", "null"],
						minimum: 0,
						maximum: 100,
					},
					fieldConfidence: { $ref: "#/$defs/fieldConfidence" },
					dedupe: { $ref: "#/$defs/transactionDedupe" },
					beancount: { $ref: "#/$defs/beancount" },
				},
			},
		},
		documentCandidates: {
			type: "array",
			maxItems: 20,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"documentType",
					"issuer",
					"externalId",
					"statementPeriodStart",
					"statementPeriodEnd",
					"dueAt",
					"taxYear",
					"attachmentRefs",
					"evidence",
					"accountRefHint",
					"institutionRefHint",
					"sourceDocumentRefs",
					"statementOpeningBalance",
					"statementClosingBalance",
					"statementTransactionCount",
					"statementCurrency",
					"book",
					"fieldConfidence",
				],
				properties: {
					documentType: { type: "string", minLength: 1, maxLength: 80 },
					issuer: { type: ["string", "null"], minLength: 1, maxLength: 240 },
					externalId: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 160,
					},
					statementPeriodStart: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 64,
					},
					statementPeriodEnd: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 64,
					},
					dueAt: { type: ["string", "null"], minLength: 1, maxLength: 64 },
					taxYear: {
						type: ["integer", "null"],
						minimum: 1900,
						maximum: 2500,
					},
					attachmentRefs: {
						type: "array",
						maxItems: 20,
						items: { type: "string", minLength: 1 },
					},
					evidence: { type: "string", minLength: 1, maxLength: 500 },
					accountRefHint: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 160,
					},
					institutionRefHint: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 160,
					},
					sourceDocumentRefs: {
						type: "array",
						maxItems: 20,
						items: { type: "string", minLength: 1, maxLength: 240 },
					},
					statementOpeningBalance: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 64,
					},
					statementClosingBalance: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 64,
					},
					statementTransactionCount: {
						type: ["integer", "null"],
						minimum: 0,
					},
					statementCurrency: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 16,
					},
					book: {
						type: "string",
						enum: ["personal", "business", "mixed", "unknown"],
					},
					fieldConfidence: { $ref: "#/$defs/fieldConfidence" },
				},
			},
		},
		matchedRegistryRefs: {
			type: "object",
			additionalProperties: false,
			required: ["identityIds", "institutionIds", "financialAccountIds"],
			properties: {
				identityIds: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				institutionIds: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				financialAccountIds: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
			},
		},
		unresolvedEntityHints: {
			type: "object",
			additionalProperties: false,
			required: ["identityHints", "institutionHints", "financialAccountHints"],
			properties: {
				identityHints: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				institutionHints: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				financialAccountHints: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
			},
		},
		dedupe: {
			type: "object",
			additionalProperties: false,
			required: [
				"messageEvidenceKey",
				"sourceDocumentRefs",
				"externalTransactionIds",
				"normalizedComposites",
			],
			properties: {
				messageEvidenceKey: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 500,
				},
				sourceDocumentRefs: {
					type: "array",
					maxItems: 20,
					items: { type: "string", minLength: 1, maxLength: 240 },
				},
				externalTransactionIds: {
					type: "array",
					maxItems: 50,
					items: { type: "string", minLength: 1, maxLength: 240 },
				},
				normalizedComposites: {
					type: "array",
					maxItems: 50,
					items: { type: "string", minLength: 1, maxLength: 500 },
				},
			},
		},
		fieldConfidence: { $ref: "#/$defs/fieldConfidence" },
		confidence: {
			type: "object",
			additionalProperties: false,
			required: [
				"overall",
				"messageKind",
				"transactionExtraction",
				"registryMatching",
			],
			properties: {
				overall: { type: "number", minimum: 0, maximum: 1 },
				messageKind: { type: "number", minimum: 0, maximum: 1 },
				transactionExtraction: { type: "number", minimum: 0, maximum: 1 },
				registryMatching: { type: "number", minimum: 0, maximum: 1 },
			},
		},
		explanation: { type: "string" },
	},
	$defs: {
		fieldConfidence: {
			type: "object",
			additionalProperties: false,
			required: [
				"amount",
				"date",
				"counterparty",
				"accountMapping",
				"book",
				"category",
				"dedupe",
			],
			properties: {
				amount: { type: ["number", "null"], minimum: 0, maximum: 1 },
				date: { type: ["number", "null"], minimum: 0, maximum: 1 },
				counterparty: { type: ["number", "null"], minimum: 0, maximum: 1 },
				accountMapping: { type: ["number", "null"], minimum: 0, maximum: 1 },
				book: { type: ["number", "null"], minimum: 0, maximum: 1 },
				category: { type: ["number", "null"], minimum: 0, maximum: 1 },
				dedupe: { type: ["number", "null"], minimum: 0, maximum: 1 },
			},
		},
		transactionDedupe: {
			type: "object",
			additionalProperties: false,
			required: [
				"externalTransactionId",
				"statementRowId",
				"normalizedComposite",
				"emailEvidenceKey",
			],
			properties: {
				externalTransactionId: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 240,
				},
				statementRowId: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 240,
				},
				normalizedComposite: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 500,
				},
				emailEvidenceKey: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 500,
				},
			},
		},
		beancount: {
			type: "object",
			additionalProperties: false,
			required: [
				"debitAccount",
				"creditAccount",
				"currency",
				"mappingKey",
				"confidence",
				"metadata",
			],
			properties: {
				debitAccount: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 240,
				},
				creditAccount: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 240,
				},
				currency: { type: ["string", "null"], minLength: 1, maxLength: 16 },
				mappingKey: {
					type: ["string", "null"],
					minLength: 1,
					maxLength: 240,
				},
				confidence: { type: "number", minimum: 0, maximum: 1 },
				metadata: { type: "object" },
			},
		},
	},
} as const;
