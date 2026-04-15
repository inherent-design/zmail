import { describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#/test/helpers/runtime";

describe("finance-intel", () => {
	it("builds a finance-intel prompt with root label and registry context", async () => {
		const runtime = await createTestRuntime();
		const financeIntel = await runtime.importFresh<
			typeof import("#/lib/finance-intel")
		>("#/lib/finance-intel");

		const prompt = financeIntel.buildFinanceIntelPrompt({
			accountLabel: "Work",
			accountEmail: "work@example.com",
			sender: "billing@example.com",
			subject: "Receipt",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "Receipt for lunch",
			attachmentsSummary: "receipt.pdf (application/pdf)",
			rootLabel: {
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
					social: 0.9,
					risk: 0.9,
				},
				explanation: "finance",
			},
			registryMatches: {
				sha256: "registry-sha",
				identities: [
					{
						id: "identity-1",
						kind: "business",
						displayName: "Inherent Design",
						aliases: ["inherent design"],
						emailAddresses: ["work@example.com"],
						domains: ["example.com"],
						taxOwnerHint: null,
						notes: null,
					},
				],
				institutions: [
					{
						id: "institution-1",
						displayName: "Amex",
						aliases: ["amex"],
						domains: ["americanexpress.com"],
						notes: null,
					},
				],
				financialAccounts: [
					{
						id: "account-1",
						institutionId: "institution-1",
						ownerIdentityId: "identity-1",
						displayName: "Business Gold",
						aliases: ["business gold"],
						accountMask: null,
						accountLast4: "4242",
						accountType: null,
						currency: null,
						taxOwnerHint: null,
						notes: null,
					},
				],
				senderRules: [
					{
						id: "rule-1",
						senderPattern: "billing@example.com",
						domain: "example.com",
						ownerIdentityId: "identity-1",
						institutionId: "institution-1",
						financialAccountId: "account-1",
						messageKindHint: "receipt",
						priority: 10,
						notes: null,
					},
				],
			},
		});

		expect(prompt).toContain("Account: Work");
		expect(prompt).toContain("Attachments: receipt.pdf (application/pdf)");
		expect(prompt).toContain('"primaryBucket": "finance"');
		expect(prompt).toContain('"displayName": "Inherent Design"');
		expect(prompt).toContain("Normalized body:");
	});

	it("sanitizes registry refs and persists a finance-intel result", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
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
						merchantOrCounterparty: "Acme",
						ownerIdentityRef: "identity-allowed",
						financialAccountRef: "account-disallowed",
						institutionRef: "institution-allowed",
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidence: "Receipt email",
					},
					{
						kind: "bank_fee",
						direction: "expense",
						amount: "5.00",
						currency: "USD",
						occurredAt: "2026-01-01",
						merchantOrCounterparty: "Acme",
						ownerIdentityRef: null,
						financialAccountRef: null,
						institutionRef: null,
						categoryHint: "fees",
						taxRelevanceHint: null,
						evidence: "Fee line item",
					},
				],
				documentCandidates: [
					{
						documentType: "receipt",
						issuer: "Acme",
						externalId: "receipt-1",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						attachmentRefs: ["receipt.pdf"],
						evidence: "Receipt attached",
					},
				],
				matchedRegistryRefs: {
					identityIds: ["junk"],
					institutionIds: ["junk"],
					financialAccountIds: ["junk"],
				},
				unresolvedEntityHints: {
					identityHints: ["   ", "manual-owner"],
					institutionHints: ["Acme Bank", "Acme Bank"],
					financialAccountHints: ["   ", "ending 4242"],
				},
				confidence: {
					overall: 0.7,
					messageKind: 0.9,
					transactionExtraction: 0.8,
					registryMatching: 0.6,
				},
				explanation: "Finance intel",
			},
			rawText: '{"ok":true}',
			usage: { totalTokens: 15 },
		}));
		const persistSecondaryResult = vi.fn(async () => ({
			resultId: "secondary-1",
			status: "review",
			lowConfidence: true,
		}));

		vi.doMock("#/lib/pi", () => ({
			piJson,
		}));
		vi.doMock("#/lib/secondary", () => ({
			persistSecondaryResult,
		}));

		const financeIntel = await runtime.importFresh<
			typeof import("#/lib/finance-intel")
		>("#/lib/finance-intel");
		const result = await financeIntel.classifyFinanceMessageNow({
			jobId: "job-1",
			messageId: "message-1",
			accountLabel: "Work",
			accountEmail: "work@example.com",
			sender: "billing@example.com",
			subject: "Receipt",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "Receipt for lunch",
			attachmentsSummary: "receipt.pdf (application/pdf)",
			rootLabel: {
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
					social: 0.9,
					risk: 0.9,
				},
				explanation: "finance",
			},
			registryMatches: {
				sha256: "registry-sha",
				identities: [
					{
						id: "identity-allowed",
						kind: "business",
						displayName: "Inherent Design",
						aliases: ["inherent design"],
						emailAddresses: ["work@example.com"],
						domains: ["example.com"],
						taxOwnerHint: null,
						notes: null,
					},
				],
				institutions: [
					{
						id: "institution-allowed",
						displayName: "Amex",
						aliases: ["amex"],
						domains: ["americanexpress.com"],
						notes: null,
					},
				],
				financialAccounts: [],
				senderRules: [],
			},
			contentSha256: "content-sha",
		});

		expect(piJson).toHaveBeenCalledOnce();
		expect(persistSecondaryResult).toHaveBeenCalledWith(
			expect.objectContaining({
				classifierKey: "finance_intel",
				contentSha256: "content-sha",
				registrySha256: "registry-sha",
				overallConfidence: 0.7,
				result: expect.objectContaining({
					matchedRegistryRefs: {
						identityIds: ["identity-allowed"],
						institutionIds: ["institution-allowed"],
						financialAccountIds: [],
					},
					unresolvedEntityHints: {
						identityHints: ["manual-owner"],
						institutionHints: ["Acme Bank"],
						financialAccountHints: ["ending 4242", "amex"],
					},
				}),
			}),
		);
		expect(result.headStatus).toBe("review");
		expect(result.lowConfidence).toBe(true);
		expect(result.financeIntel.transactionCandidates[0]).toMatchObject({
			ownerIdentityRef: "identity-allowed",
			institutionRef: "institution-allowed",
			financialAccountRef: null,
		});
		expect(result.model).toBe("gpt-5.4-mini");
		expect(result.backend).toBe("openai-subscription");
		expect(result.usage).toEqual({ totalTokens: 15 });
	});

	it("adds owner fallback hints when the registry has no identity matches", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: {
				schemaVersion: "finance-intel.v1",
				messageKind: "statement",
				actionability: "capture_document",
				transactionCandidates: [],
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
				explanation: "Finance intel",
			},
			rawText: '{"ok":true}',
			usage: { totalTokens: 10 },
		}));
		const persistSecondaryResult = vi.fn(async () => ({
			resultId: "secondary-2",
			status: "ready",
			lowConfidence: false,
		}));

		vi.doMock("#/lib/pi", () => ({
			piJson,
		}));
		vi.doMock("#/lib/secondary", () => ({
			persistSecondaryResult,
		}));

		const financeIntel = await runtime.importFresh<
			typeof import("#/lib/finance-intel")
		>("#/lib/finance-intel");
		await financeIntel.classifyFinanceMessageNow({
			messageId: "message-2",
			accountLabel: "Work",
			accountEmail: "work@example.com",
			sender: "alerts@example.com",
			subject: "Statement",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "Monthly statement ready",
			attachmentsSummary: "statement.pdf (application/pdf)",
			rootLabel: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "neither",
					owner: "business",
					accountHint: null,
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
					overall: 0.95,
					finance: 0.95,
					social: 0.95,
					risk: 0.95,
				},
				explanation: "finance",
			},
			registryMatches: {
				sha256: "registry-sha-2",
				identities: [],
				institutions: [],
				financialAccounts: [
					{
						id: "account-1",
						institutionId: null,
						ownerIdentityId: null,
						displayName: "Checking",
						aliases: ["checking"],
						accountMask: null,
						accountLast4: "4242",
						accountType: null,
						currency: null,
						taxOwnerHint: null,
						notes: null,
					},
				],
				senderRules: [],
			},
			contentSha256: "content-sha-2",
		});

		expect(persistSecondaryResult).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({
					unresolvedEntityHints: {
						identityHints: ["business"],
						institutionHints: [],
						financialAccountHints: [],
					},
				}),
			}),
		);
	});
});
