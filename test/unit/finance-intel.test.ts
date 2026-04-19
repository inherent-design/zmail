import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { financeIntelV3Schema } from "#/lib/schemas";
import { bootDb, insertMessageRow } from "#/test/helpers/db";
import {
	buildFinanceIntelV3,
	buildMessageLabelV3,
} from "#/test/helpers/labels";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("finance-intel", () => {
	it("documents exact required finance-intel v3 output keys", () => {
		const prompt = readFileSync(
			resolve(process.cwd(), "prompts", "finance-intel-v3.md"),
			"utf8",
		);

		expect(prompt).toContain("Every required key in the JSON contract");
		expect(prompt).toContain("Use `null`, not omission");
		expect(prompt).toContain("Use `[]`, not omission");
		expect(prompt).toContain("occurredAt");
		expect(prompt).toContain("merchantOrCounterparty");
		expect(prompt).toContain("`tax` -> `tax_document`");
	});

	it("normalizes common model-output aliases into strict finance-intel v3", async () => {
		const runtime = await createTestRuntime();
		const financeIntel = await runtime.importFresh<
			typeof import("#/lib/finance-intel")
		>("#/lib/finance-intel");

		const normalized = financeIntel.normalizeFinanceIntelV3ModelOutput(
			{
				messageKind: "tax",
				actionability: "create_transaction_candidate",
				book: {
					scope: "business",
				},
				ledgerReadiness: {
					status: "exportable",
					requiredFixes: [
						"This item needs a manual accounting review before ledger export.",
					],
				},
				transactionCandidates: [
					{
						kind: "card_charge",
						direction: "debit",
						amount: { value: "42.00", currency: "USD" },
						transactionDate: "2026-01-02",
						counterparty: "Example SaaS",
						category: {
							primary: "software_services",
							secondary: "hosting",
						},
						book: "mixed",
					},
				],
			},
			{
				messageId: "message-alias",
				rootSignal: "tax",
				rootBookHint: "business",
				rootEvidence: "Root finance evidence.",
			},
		);
		const parsed = financeIntelV3Schema.parse(normalized);

		expect(parsed.messageKind).toBe("tax_document");
		expect(parsed.book).toMatchObject({
			scope: "business",
			businessUsePercent: null,
			taxTreatmentHint: null,
			evidence: "Root finance evidence.",
		});
		expect(parsed.matchedRegistryRefs).toEqual({
			identityIds: [],
			institutionIds: [],
			financialAccountIds: [],
		});
		expect(parsed.dedupe).toMatchObject({
			messageEvidenceKey: null,
			sourceDocumentRefs: [],
			externalTransactionIds: [],
			normalizedComposites: [],
		});
		expect(parsed.ledgerReadiness.status).toBe("review");
		expect(parsed.ledgerReadiness.requiredFixes).toEqual(["accountMapping"]);
		expect(parsed.transactionCandidates[0]).toMatchObject({
			direction: "expense",
			amount: "42.00",
			currency: "USD",
			occurredAt: "2026-01-02",
			merchantOrCounterparty: "Example SaaS",
			categoryPrimary: "software_services",
			categorySecondary: "hosting",
			book: "unknown",
			businessUsePercent: null,
			beancount: {
				debitAccount: null,
				creditAccount: null,
				mappingKey: null,
				confidence: 0,
			},
		});

		const other = financeIntelV3Schema.parse(
			financeIntel.normalizeFinanceIntelV3ModelOutput(
				{ messageKind: "other", actionability: "none" },
				{
					messageId: "message-other",
					rootSignal: "other",
					rootBookHint: "unknown",
					rootEvidence: null,
				},
			),
		);
		expect(other.messageKind).toBe("other_finance");
	});

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
			rootLabel: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Client lunch receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
			}),
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
				accountMappings: [],
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
		const { db } = await bootDb({ seedDefaultAccount: true });
		await insertMessageRow(db, {
			id: "message-1",
			accountId: "acct-1",
			contentSha256: "content-sha",
		});
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: buildFinanceIntelV3({
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
						categoryPrimary: "software_services",
						categorySecondary: "software",
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
						categoryPrimary: "banking_fees",
						categorySecondary: "fees",
						taxRelevanceHint: null,
						evidence: "Fee line item",
					},
				],
				documentCandidates: [],
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
			}),
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
			rootLabel: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Client lunch receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
			}),
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
				accountMappings: [],
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
						financialAccountHints: ["ending 4242"],
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
		expect(result.blockedModelOutput).toBe(false);
	});

	it("persists a blocked finance result when normalized model output remains invalid", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: {
				messageKind: "tax",
				actionability: "create_transaction_candidate",
				transactionCandidates: Array.from({ length: 21 }, (_, index) => ({
					kind: "card_charge",
					direction: "debit",
					amount: { value: String(index + 1), currency: "USD" },
					transactionDate: "2026-01-02",
					counterparty: "Example SaaS",
				})),
			},
			rawText: '{"tooMany":true}',
			usage: { totalTokens: 20 },
		}));
		const persistSecondaryResult = vi.fn(async () => ({
			resultId: "secondary-blocked",
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
			jobId: "job-blocked",
			messageId: "message-blocked",
			accountLabel: "Work",
			accountEmail: "work@example.com",
			sender: "tax@example.com",
			subject: "Tax notice",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "Tax document available",
			attachmentsSummary: "none",
			rootLabel: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "tax",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Tax document.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["tax"],
					tags: ["tax"],
				},
			}),
			registryMatches: {
				sha256: "registry-sha",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
				accountMappings: [],
			},
			contentSha256: "content-sha",
		});

		expect(result.blockedModelOutput).toBe(true);
		expect(result.financeIntel).toMatchObject({
			messageKind: "tax_document",
			actionability: "manual_review",
			ledgerReadiness: {
				status: "blocked",
				reasons: ["model_output_invalid"],
				requiredFixes: ["manualReview"],
			},
			dedupe: {
				messageEvidenceKey: "email:message-blocked",
			},
			confidence: {
				overall: 0,
				messageKind: 0,
				transactionExtraction: 0,
				registryMatching: 0,
			},
		});
		expect(persistSecondaryResult).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "review",
				overallConfidence: 0,
				rawResponse: expect.objectContaining({
					assistantText: '{"tooMany":true}',
					parseError: expect.any(String),
				}),
			}),
		);
	});

	it("persists a blocked finance result for model JSON parse failures", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => {
			throw new SyntaxError("Unexpected token o in JSON");
		});
		const persistSecondaryResult = vi.fn(async () => ({
			resultId: "secondary-json-blocked",
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
			jobId: "job-json-blocked",
			messageId: "message-json-blocked",
			accountLabel: "Work",
			accountEmail: "work@example.com",
			sender: "billing@example.com",
			subject: "Broken JSON",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyText: "Receipt text",
			attachmentsSummary: "none",
			rootLabel: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "other",
					operational: true,
					bookHint: "unknown",
					requiresFinanceIntel: true,
					confidence: 0.7,
					evidence: "Finance-adjacent message.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: [],
					tags: ["finance"],
				},
			}),
			registryMatches: {
				sha256: "registry-sha",
				identities: [],
				institutions: [],
				financialAccounts: [],
				senderRules: [],
				accountMappings: [],
			},
			contentSha256: "content-sha",
		});

		expect(result.blockedModelOutput).toBe(true);
		expect(result.backend).toBe("model_parse_error");
		expect(result.financeIntel).toMatchObject({
			messageKind: "other_finance",
			ledgerReadiness: {
				status: "blocked",
				reasons: ["model_output_invalid"],
			},
		});
		expect(persistSecondaryResult).toHaveBeenCalledWith(
			expect.objectContaining({
				backend: "model_parse_error",
				status: "review",
				rawResponse: {
					assistantText: null,
					parseError: "Unexpected token o in JSON",
				},
			}),
		);
	});

	it("does not synthesize owner fallback hints when registry has no identity matches", async () => {
		const runtime = await createTestRuntime();
		const piJson = vi.fn(async () => ({
			backend: "openai-subscription",
			modelId: "gpt-5.4-mini",
			parsed: buildFinanceIntelV3({
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
			}),
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
			rootLabel: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "statement",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Monthly statement ready.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["statement"],
					tags: ["statement"],
				},
			}),
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
				accountMappings: [],
			},
			contentSha256: "content-sha-2",
		});

		expect(persistSecondaryResult).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({
					unresolvedEntityHints: {
						identityHints: [],
						institutionHints: [],
						financialAccountHints: [],
					},
				}),
			}),
		);
	});
});
