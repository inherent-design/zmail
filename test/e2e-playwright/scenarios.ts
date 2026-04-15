import { buildFinanceIntelV2, buildMessageLabelV2 } from "#/test/helpers/labels";

export interface BrowserAccountScenario {
	id: string;
	label: string;
	email: string;
	syncEnabled: number;
	syncStatus:
		| "idle"
		| "syncing"
		| "backfilling"
		| "needs_reconnect"
		| "resync_required"
		| "paused"
		| "error";
	hasOAuthToken: boolean;
}

export interface BrowserMessageScenario {
	id: string;
	remoteId: string;
	subject: string;
	body: string;
	senderName: string;
	senderAddress: string;
	receivedAt: string;
	attachmentName?: string;
}

export const PLAYWRIGHT_SCENARIOS = {
	backlog: {
		account: {
			id: "pw-account-backlog",
			label: "PW Backlog Gmail",
			email: "pw-backlog@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
			hasOAuthToken: true,
		} satisfies BrowserAccountScenario,
		message: {
			id: "pw-message-backlog",
			remoteId: "910000000000000101",
			subject: "Client lunch receipt",
			body: [
				"Thanks for dining with Harbor Cafe.",
				"Total charged: $82.14.",
				"Card: business visa ending 4242.",
				"Purpose: lunch with client to discuss contract renewal.",
			].join("\n"),
			senderName: "Vendor Billing",
			senderAddress: "billing@vendor.example",
			receivedAt: "2026-04-11T10:00:00.000Z",
			attachmentName: "receipt.pdf",
		} satisfies BrowserMessageScenario,
	},
	classifyNow: {
		account: {
			id: "pw-account-classify-now",
			label: "PW Classify Gmail",
			email: "pw-classify@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
			hasOAuthToken: true,
		} satisfies BrowserAccountScenario,
		message: {
			id: "pw-message-classify-now",
			remoteId: "910000000000000102",
			subject: "Birthday party invite",
			body: [
				"Hey,",
				"You're invited to my birthday party this Saturday at 7pm.",
				"Bring snacks if you want.",
			].join("\n"),
			senderName: "Friend",
			senderAddress: "friend@example.com",
			receivedAt: "2026-04-10T17:00:00.000Z",
		} satisfies BrowserMessageScenario,
	},
	review: {
		account: {
			id: "pw-account-review",
			label: "PW Review Gmail",
			email: "pw-review@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
			hasOAuthToken: true,
		} satisfies BrowserAccountScenario,
		message: {
			id: "pw-message-review",
			remoteId: "910000000000000103",
			subject: "Ambiguous team dinner receipt",
			body: [
				"Receipt attached.",
				"Not sure whether to book this as business or personal.",
			].join("\n"),
			senderName: "Accounting",
			senderAddress: "accounting@example.com",
			receivedAt: "2026-04-09T08:30:00.000Z",
		} satisfies BrowserMessageScenario,
		reviewId: "pw-review-open",
	},
	reconnect: {
		account: {
			id: "pw-account-reconnect",
			label: "PW Needs Reconnect",
			email: "pw-reconnect@example.com",
			syncEnabled: 0,
			syncStatus: "needs_reconnect",
			hasOAuthToken: false,
		} satisfies BrowserAccountScenario,
	},
	disconnected: {
		account: {
			id: "pw-account-disconnected",
			label: "PW Disconnected Gmail",
			email: "pw-disconnected@example.com",
			syncEnabled: 0,
			syncStatus: "idle",
			hasOAuthToken: false,
		} satisfies BrowserAccountScenario,
	},
	delete: {
		account: {
			id: "pw-account-delete",
			label: "PW Delete Gmail",
			email: "pw-delete@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
			hasOAuthToken: true,
		} satisfies BrowserAccountScenario,
		message: {
			id: "pw-message-delete",
			remoteId: "910000000000000104",
			subject: "Delete me receipt",
			body: "This message exists so delete flow removes local corpus state.",
			senderName: "Delete Sender",
			senderAddress: "delete@example.com",
			receivedAt: "2026-04-08T09:00:00.000Z",
		} satisfies BrowserMessageScenario,
	},
	finance: {
		account: {
			id: "pw-account-finance",
			label: "PW Finance Gmail",
			email: "pw-finance@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
			hasOAuthToken: true,
		} satisfies BrowserAccountScenario,
		emailMessage: {
			id: "pw-message-finance-email",
			remoteId: "910000000000000105",
			subject: "Acme Cloud receipt",
			body: [
				"Receipt for Acme Cloud.",
				"Amount: $42.00",
				"Business SaaS renewal.",
			].join("\n"),
			senderName: "Acme Cloud",
			senderAddress: "billing@acme-cloud.example",
			receivedAt: "2026-03-15T12:00:00.000Z",
		} satisfies BrowserMessageScenario,
	},
} as const;

export const PLAYWRIGHT_ACCOUNT_IDS = Object.values(PLAYWRIGHT_SCENARIOS).map(
	(scenario) => scenario.account.id,
);

export function buildSeededReviewLabel() {
	return buildMessageLabelV2({
		finance: {
			relevant: true,
			direction: "expense",
			owner: "unknown",
			accountHint: null,
			purpose: null,
		},
		people: {
			personal: false,
			private: false,
			networking: false,
			community: false,
			recruiting: false,
			business: true,
		},
		routing: {
			primaryBucket: "finance",
			secondaryBuckets: ["receipt"],
			tags: ["review"],
		},
		confidence: {
			overall: 0.42,
			finance: 0.61,
			people: 0.52,
			commerce: 0.7,
			knowledge: 0.7,
			assets: 0.7,
			entertainment: 0.7,
			risk: 0.93,
		},
		explanation: "Likely an expense, but the owner is ambiguous.",
	});
}

export function buildFinanceScenarioIntel() {
	return buildFinanceIntelV2({
		messageKind: "receipt",
		transactionCandidates: [
			{
				kind: "card_charge",
				direction: "expense",
				amount: "42.00",
				currency: "USD",
				occurredAt: "2026-03-15",
				merchantOrCounterparty: "Acme Cloud",
				ownerIdentityRef: "owner:finance",
				financialAccountRef: "acct:finance",
				institutionRef: "inst:finance-bank",
				categoryPrimary: "software_services",
				categorySecondary: "saas",
				statementRefHint: null,
				taxRelevanceHint: "business expense",
				evidence: "Acme Cloud SaaS renewal.",
			},
		],
		documentCandidates: [
			{
				documentType: "receipt",
				issuer: "Acme Cloud",
				externalId: "acme-receipt-42",
				statementPeriodStart: null,
				statementPeriodEnd: null,
				dueAt: null,
				taxYear: 2026,
				accountRefHint: "acct:finance",
				institutionRefHint: "inst:finance-bank",
				attachmentRefs: [],
				evidence: "Email receipt for Acme Cloud.",
			},
		],
	});
}
