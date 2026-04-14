export const LIVE_ACCOUNT_ID = "playwright-live-account";
export const LIVE_ACCOUNT_LABEL = "Playwright Live Gmail";
export const LIVE_ACCOUNT_EMAIL = "playwright-live@example.com";

export const BACKLOG_MESSAGE_ID = "playwright-message-backlog";
export const BACKLOG_REMOTE_ID = "910000000000000001";
export const BACKLOG_SUBJECT = "Client lunch receipt";
export const BACKLOG_BODY = [
	"Thanks for dining with Harbor Cafe.",
	"Total charged: $82.14.",
	"Card: business visa ending 4242.",
	"Purpose: lunch with client to discuss contract renewal.",
].join("\n");

export const CLASSIFY_NOW_MESSAGE_ID = "playwright-message-classify-now";
export const CLASSIFY_NOW_REMOTE_ID = "910000000000000002";
export const CLASSIFY_NOW_SUBJECT = "Birthday party invite";
export const CLASSIFY_NOW_BODY = [
	"Hey,",
	"You're invited to my birthday party this Saturday at 7pm.",
	"Bring snacks if you want.",
].join("\n");

export const REVIEW_MESSAGE_ID = "playwright-message-review";
export const REVIEW_REMOTE_ID = "910000000000000003";
export const REVIEW_SUBJECT = "Ambiguous team dinner receipt";
export const REVIEW_BODY = [
	"Receipt attached.",
	"Not sure whether to book this as business or personal.",
].join("\n");
export const REVIEW_ROW_ID = "playwright-review-open";
export const REVIEW_RESULT_ID = "playwright-classification-low-confidence";
export const SEEDED_PROFILE_ID = "playwright-overseer-profile";

export function buildLowConfidenceLabel() {
	return {
		schemaVersion: "message-label.v1" as const,
		nsfw: false,
		finance: {
			relevant: true,
			direction: "expense" as const,
			owner: "unknown" as const,
			accountHint: null,
			purpose: null,
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
			primaryBucket: "other" as const,
			tags: ["review"],
		},
		confidence: {
			overall: 0.42,
			finance: 0.61,
			social: 0.52,
			risk: 0.93,
		},
		explanation: "Likely an expense, but the owner is ambiguous.",
	};
}

export function buildSeededProfile() {
	return {
		schemaVersion: "overseer-profile.v1" as const,
		accountId: LIVE_ACCOUNT_ID,
		builtFromMessages: 1,
		knownBusinessDomains: ["vendor.example"],
		knownPersonalDomains: ["friends.example"],
		knownFinancialSenders: ["billing@vendor.example"],
		recurringPurposeHints: ["meals", "events"],
		confidentialityPatterns: ["contract renewal", "client dinner"],
		promotedTags: ["receipt", "event"],
		promptPreamble:
			"This account often receives business meal receipts and occasional personal invites.",
	};
}
