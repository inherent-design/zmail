import { describe, expect, it } from "vitest";

import {
	accountRecordSchema,
	financeIntelJsonSchema,
	financeIntelV3Schema,
	financeLedgerExportSchema,
	financeMappingUpsertInputSchema,
	financeSourceImportV2Schema,
	messageLabelSchema,
	messageLabelV3Schema,
	messageModerationSchema,
	normalizeFinanceFilterSourceKind,
	normalizeFinanceImportSourceKind,
	parseCurrentFinanceIntel,
	resolveReviewInputSchema,
	reviewClassifierSchema,
	taxBusinessQuarterPackageInputSchema,
	taxPersonalPackageInputSchema,
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
		expect(
			resolveReviewInputSchema.parse({
				reviewId: "review-1",
				action: "defer",
				note: "Needs source evidence.",
			}),
		).toMatchObject({ action: "defer" });

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

	it("validates review-classifier output and finance close command inputs", () => {
		expect(
			reviewClassifierSchema.parse({
				schemaVersion: "review-classifier.v1",
				summary: "One mapping gap found.",
				findings: [
					{
						targetKind: "finance_ledger_entry",
						targetId: "ledger-1",
						severity: "medium",
						action: "mapping_needed",
						confidence: 0.88,
						reason: "Row has amount/date but no account mapping.",
						evidenceRefs: ["ledger:ledger-1"],
					},
				],
				targetedReclassification: [
					{
						classifier: "finance",
						messageIds: ["msg-1"],
						reason: "Finance extraction missed mapping evidence.",
					},
				],
				mappingSuggestionRefs: ["suggestion-1"],
				overseerSignals: ["Sender often sends business receipts."],
			}),
		).toMatchObject({ schemaVersion: "review-classifier.v1" });

		expect(
			financeMappingUpsertInputSchema.parse({
				mapping: {
					mappingKey: "example",
					book: "business",
					match: { textIncludes: ["Example"] },
					debitAccount: "Expenses:Business:Software",
					creditAccount: "Assets:Personal:Checking",
					currency: "USD",
					confidence: 0.9,
					notes: null,
				},
			}),
		).toMatchObject({ mapping: { mappingKey: "example" } });

		expect(taxPersonalPackageInputSchema.parse({ year: 2025 })).toMatchObject({
			year: 2025,
		});
		expect(
			taxBusinessQuarterPackageInputSchema.parse({
				year: 2025,
				quarter: 2,
			}),
		).toMatchObject({ businessSlug: "inherent-design" });
	});

	it("accepts message-label.v3 finance gate labels", () => {
		const label = messageLabelV3Schema.parse({
			schemaVersion: "message-label.v3",
			nsfw: false,
			finance: {
				relevant: true,
				signal: "receipt",
				operational: true,
				bookHint: "business",
				requiresFinanceIntel: true,
				confidence: 0.94,
				evidence: "Receipt with amount and merchant.",
			},
			people: {
				personal: false,
				private: false,
				networking: false,
				community: false,
				recruiting: false,
				business: true,
			},
			commerce: {
				transactional: true,
				shopping: false,
				subscription: true,
				travel: false,
				legal: false,
			},
			knowledge: {
				course: false,
				resource: false,
				documentation: false,
				newsletter: false,
				research: false,
			},
			assets: {
				license: false,
				credential: false,
				account: false,
				document: true,
			},
			entertainment: {
				gaming: false,
				media: false,
				fandom: false,
			},
			risk: {
				businessSensitive: false,
				leakRisk: false,
			},
			routing: {
				primaryBucket: "finance",
				secondaryBuckets: ["receipt", "subscription"],
				tags: ["receipt"],
			},
			confidence: {
				overall: 0.92,
				finance: 0.94,
				people: 0.8,
				commerce: 0.9,
				knowledge: 0.7,
				assets: 0.8,
				entertainment: 0.9,
				risk: 0.8,
			},
			explanation: "Business software receipt.",
		});

		expect(messageLabelSchema.parse(label)).toMatchObject({
			schemaVersion: "message-label.v3",
			finance: { requiresFinanceIntel: true },
		});
	});

	it("validates finance-intel.v3 ledger readiness", () => {
		const fieldConfidence = {
			amount: 0.99,
			date: 0.95,
			counterparty: 0.9,
			accountMapping: 0.8,
			book: 0.9,
			category: 0.8,
			dedupe: 0.85,
		};
		const candidate = {
			kind: "receipt",
			direction: "expense",
			amount: "42.00",
			currency: "USD",
			occurredAt: "2026-01-02",
			merchantOrCounterparty: "Example SaaS",
			ownerIdentityRef: null,
			financialAccountRef: null,
			institutionRef: null,
			categoryPrimary: "software_services",
			categorySecondary: "hosting",
			statementRefHint: null,
			taxRelevanceHint: "Business software",
			evidence: "Receipt total.",
			externalTransactionId: "txn_123",
			postedAt: "2026-01-03",
			clearedAt: null,
			book: "business",
			businessUsePercent: null,
			fieldConfidence,
			dedupe: {
				externalTransactionId: "txn_123",
				statementRowId: null,
				normalizedComposite: "2026-01-02|example-saas|42.00|usd",
				emailEvidenceKey: "msg-1",
			},
			beancount: {
				debitAccount: "Expenses:Business:Software",
				creditAccount: "Assets:Business:Bank:Checking",
				currency: "USD",
				mappingKey: "example-saas:business-software",
				confidence: 0.9,
				metadata: {},
			},
		};

		expect(
			financeIntelV3Schema.parse({
				schemaVersion: "finance-intel.v3",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				book: {
					scope: "business",
					businessUsePercent: null,
					taxTreatmentHint: "Business software",
					evidence: "Receipt is for business software.",
				},
				ledgerReadiness: {
					status: "exportable",
					reasons: [],
					requiredFixes: [],
				},
				transactionCandidates: [candidate],
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
				dedupe: {
					messageEvidenceKey: "msg-1",
					sourceDocumentRefs: [],
					externalTransactionIds: ["txn_123"],
					normalizedComposites: ["2026-01-02|example-saas|42.00|usd"],
				},
				fieldConfidence,
				confidence: {
					overall: 0.94,
					messageKind: 0.9,
					transactionExtraction: 0.96,
					registryMatching: 0.75,
				},
				explanation: "Receipt has enough data for ledger staging.",
			}),
		).toMatchObject({ schemaVersion: "finance-intel.v3" });

		expect(() =>
			financeIntelV3Schema.parse({
				schemaVersion: "finance-intel.v3",
				messageKind: "receipt",
				actionability: "create_transaction_candidate",
				book: {
					scope: "mixed",
					businessUsePercent: null,
					taxTreatmentHint: null,
					evidence: "Mixed-use row lacks allocation.",
				},
				ledgerReadiness: {
					status: "review",
					reasons: ["Needs allocation."],
					requiredFixes: ["businessUsePercent"],
				},
				transactionCandidates: [{ ...candidate, book: "mixed" }],
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
				dedupe: {
					messageEvidenceKey: "msg-1",
					sourceDocumentRefs: [],
					externalTransactionIds: ["txn_123"],
					normalizedComposites: [],
				},
				fieldConfidence,
				confidence: {
					overall: 0.7,
					messageKind: 0.9,
					transactionExtraction: 0.8,
					registryMatching: 0.4,
				},
				explanation: "Mixed-use row lacks allocation.",
			}),
		).toThrow();
	});

	it("exposes a nested finance-intel.v3 JSON contract", () => {
		const contract = financeIntelJsonSchema as unknown as {
			readonly properties: Record<
				string,
				{
					readonly enum?: readonly string[];
					readonly items?: {
						readonly properties?: Record<string, unknown>;
					};
					readonly properties?: Record<string, unknown>;
				}
			>;
		};
		expect(contract.properties.messageKind?.enum).toEqual(
			expect.arrayContaining([
				"receipt",
				"tax_document",
				"finance_promotion",
				"other_finance",
			]),
		);
		expect(
			contract.properties.transactionCandidates?.items?.properties?.occurredAt,
		).toBeDefined();
		expect(
			contract.properties.transactionCandidates?.items?.properties
				?.merchantOrCounterparty,
		).toBeDefined();
		expect(
			contract.properties.matchedRegistryRefs?.properties?.identityIds,
		).toBeDefined();
	});

	it("accepts minimal not-ledger finance-intel.v3 fixtures", () => {
		expect(
			financeIntelV3Schema.parse({
				schemaVersion: "finance-intel.v3",
				messageKind: "finance_promotion",
				actionability: "none",
				book: {
					scope: "unknown",
					businessUsePercent: null,
					taxTreatmentHint: null,
					evidence: null,
				},
				ledgerReadiness: {
					status: "not_ledger",
					reasons: ["No transaction or document evidence."],
					requiredFixes: [],
				},
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
				dedupe: {
					messageEvidenceKey: null,
					sourceDocumentRefs: [],
					externalTransactionIds: [],
					normalizedComposites: [],
				},
				fieldConfidence: {
					amount: null,
					date: null,
					counterparty: null,
					accountMapping: null,
					book: null,
					category: null,
					dedupe: null,
				},
				confidence: {
					overall: 0.8,
					messageKind: 0.8,
					transactionExtraction: 0,
					registryMatching: 0,
				},
				explanation: "No ledger-ready finance evidence.",
			}),
		).toMatchObject({
			schemaVersion: "finance-intel.v3",
			ledgerReadiness: { status: "not_ledger" },
		});
	});

	it("rejects missing required nested arrays in current finance-intel.v3 state", () => {
		expect(
			parseCurrentFinanceIntel({
				schemaVersion: "finance-intel.v3",
				messageKind: "finance_promotion",
				actionability: "none",
				book: {
					scope: "unknown",
					businessUsePercent: null,
					taxTreatmentHint: null,
					evidence: null,
				},
				ledgerReadiness: {
					status: "not_ledger",
					reasons: ["No transaction or document evidence."],
					requiredFixes: [],
				},
				transactionCandidates: [],
				documentCandidates: [],
				matchedRegistryRefs: {
					identityIds: [],
				},
				unresolvedEntityHints: {
					identityHints: [],
					institutionHints: [],
					financialAccountHints: [],
				},
				dedupe: {
					messageEvidenceKey: null,
					sourceDocumentRefs: [],
					externalTransactionIds: [],
					normalizedComposites: [],
				},
				fieldConfidence: {
					amount: null,
					date: null,
					counterparty: null,
					accountMapping: null,
					book: null,
					category: null,
					dedupe: null,
				},
				confidence: {
					overall: 0.8,
					messageKind: 0.8,
					transactionExtraction: 0,
					registryMatching: 0,
				},
				explanation: "No ledger-ready finance evidence.",
			}),
		).toBeNull();
	});

	it("accepts finance-source-import.v2 provenance fields", () => {
		expect(
			financeSourceImportV2Schema.parse({
				schemaVersion: "finance-source-import.v2",
				sourceKind: "csv",
				sourceFile: {
					absolutePath: "/tmp/statement.csv",
					sha256: "abc",
					filename: "statement.csv",
					importedAt: "2026-01-04T00:00:00.000Z",
				},
				artifactSha256: "def",
				extractor: {
					runner: "test",
					model: "fixture",
					promptVersion: "finance-source-import.v2",
					extractedTextHash: null,
				},
				registrySuggestions: {
					identities: [],
					institutions: [],
					financialAccounts: [],
					senderRules: [],
				},
				documents: [
					{
						sourceDocumentRef: "stmt-1",
						documentType: "statement",
						issuer: "Bank",
						externalId: "S-1",
						statementPeriodStart: "2026-01-01",
						statementPeriodEnd: "2026-01-31",
						dueAt: null,
						taxYear: 2026,
						ownerIdentityHint: null,
						financialAccountHint: "Checking",
						institutionHint: "Bank",
						evidenceText: "Statement period.",
						statementOpeningBalance: "100.00",
						statementClosingBalance: "50.00",
						statementTransactionCount: 1,
						statementCurrency: "USD",
						accountMappingKey: "bank:checking",
						extractionConfidence: 0.98,
						rawPayload: { rowCount: 1 },
					},
				],
				transactions: [
					{
						sourceDocumentRef: "stmt-1",
						occurredAt: "2026-01-02",
						postedAt: "2026-01-03",
						amount: "-50.00",
						currency: "USD",
						direction: "expense",
						description: "Example SaaS",
						merchantOrCounterparty: "Example SaaS",
						balance: "50.00",
						ownerIdentityHint: null,
						financialAccountHint: "Checking",
						institutionHint: "Bank",
						categoryPrimary: "software_services",
						categorySecondary: "hosting",
						evidenceText: "CSV row.",
						externalTransactionId: "ext-1",
						clearedAt: "2026-01-04",
						statementRowId: "row-1",
						rowIndex: 0,
						accountMappingKey: "bank:checking",
						bookHint: "business",
						businessUsePercent: null,
						extractionConfidence: 0.99,
						rowProvenance: { line: 2 },
						rawPayload: { row: 1 },
					},
				],
				provenance: { parser: "fixture" },
			}),
		).toMatchObject({ schemaVersion: "finance-source-import.v2" });
	});

	it("normalizes legacy statement source kind to text", () => {
		expect(normalizeFinanceImportSourceKind("statement")).toBe("text");
		expect(normalizeFinanceFilterSourceKind("statement")).toBe("text");
		expect(
			financeSourceImportV2Schema.parse({
				schemaVersion: "finance-source-import.v2",
				sourceKind: "statement",
				sourceFile: {
					absolutePath: "/tmp/statement.txt",
					sha256: "source-sha",
					filename: "statement.txt",
					importedAt: "2026-01-05T00:00:00.000Z",
				},
				extractor: {
					runner: "test",
					model: "test",
					promptVersion: "test",
					extractedTextHash: null,
				},
				registrySuggestions: {
					identities: [],
					institutions: [],
					financialAccounts: [],
					senderRules: [],
				},
				documents: [],
				transactions: [],
				provenance: {},
			}).sourceKind,
		).toBe("text");
	});

	it("accepts finance-ledger-export.v1 manifests", () => {
		expect(
			financeLedgerExportSchema.parse({
				schemaVersion: "finance-ledger-export.v1",
				orgId: "org_1",
				exportRunId: "run_1",
				generatedAt: "2026-01-05T00:00:00.000Z",
				strict: true,
				year: 2026,
				files: {
					main: "main.beancount",
					accounts: "accounts.beancount",
					generated: ["generated/2026.beancount"],
					raw: "raw/zmail-finance-export.json",
					unresolved: "review/unresolved.csv",
					documents: [],
				},
				items: [
					{
						canonicalKey: "txn_123",
						status: "exported",
						sourceKind: "ledger_entry",
						beancountDate: "2026-01-05",
						beancountDateSource: "posted_at",
						dateRecovery: {
							recoveredField: "posted_at",
							recoveredFrom: "message_received_at",
						},
						beancountLink: "zmail-txn-123",
						messageId: "msg-1",
						sourceImportId: null,
						reason: null,
					},
				],
				unresolvedRows: [],
				validation: {
					beanCheck: "skipped",
					beanCheckOutput: "bean-check not installed",
					favaSmoke: "manual",
				},
			}),
		).toMatchObject({ schemaVersion: "finance-ledger-export.v1" });
	});

	it("accepts finance-ledger-export.v2 manifests", () => {
		expect(
			financeLedgerExportSchema.parse({
				schemaVersion: "finance-ledger-export.v2",
				orgId: "org_1",
				exportRunId: "run_2",
				generatedAt: "2026-01-05T00:00:00.000Z",
				strict: true,
				year: null,
				years: [2025, 2026],
				files: {
					main: "main.beancount",
					accounts: "accounts.beancount",
					generated: ["generated/2025.beancount", "generated/2026.beancount"],
					raw: "raw/zmail-finance-export.json",
					unresolved: "review/unresolved.csv",
					documents: ["documents/import-doc-1-statement.pdf"],
				},
				readiness: {
					readyCount: 1,
					reviewCount: 1,
					blockedCount: 0,
					duplicateCount: 0,
					mappingCoverage: {
						mappedRows: 1,
						totalRows: 2,
						ratio: 0.5,
					},
					missingAmountCount: 0,
					missingCurrencyCount: 0,
					missingDateCount: 1,
					missingCounterpartyCount: 0,
					missingDedupeCount: 0,
					invalidBookCount: 0,
					mixedMissingBusinessUsePercentCount: 0,
					badDirectionCount: 0,
				},
				items: [
					{
						canonicalKey: "txn_123",
						status: "exported",
						sourceKind: "ledger_entry",
						beancountDate: "2026-01-05",
						beancountDateSource: "posted_at",
						dateRecovery: null,
						beancountLink: "zmail-txn-123",
						messageId: "msg-1",
						sourceImportId: null,
						reason: null,
					},
				],
				rows: [
					{
						ledgerEntry: { id: "ledger-1" },
						source: {
							ledgerEntrySource: { id: "source-1" },
							importRun: { id: "import-run-1" },
							importDocument: { id: "import-doc-1" },
						},
						eligibility: {
							exportable: true,
							reasons: [],
							beancountDate: "2026-01-05",
							beancountDateSource: "posted_at",
							dateRecovery: null,
							confidenceUsed: 0.95,
							threshold: 0.8,
						},
						export: {
							status: "exported",
							generatedFile: "generated/2026.beancount",
							beancountLink: "zmail-txn-123",
						},
						documents: {
							emitted: ["documents/import-doc-1-statement.pdf"],
							missing: [],
						},
					},
				],
				validation: {
					beanCheck: "passed",
					beanCheckOutput: null,
					favaSmoke: "manual",
				},
			}),
		).toMatchObject({ schemaVersion: "finance-ledger-export.v2" });
	});

	it("accepts extended finance-ledger-export.v2 manifests", () => {
		expect(
			financeLedgerExportSchema.parse({
				schemaVersion: "finance-ledger-export.v2",
				orgId: "org_1",
				exportRunId: "run_3",
				generatedAt: "2026-01-05T00:00:00.000Z",
				strict: true,
				year: 2026,
				years: [2026],
				files: {
					main: "main.beancount",
					accounts: "accounts.beancount",
					generated: ["generated/2026.beancount"],
					raw: "raw/zmail-finance-export.json",
					unresolved: "review/unresolved.csv",
					documents: ["documents/import-doc-1-statement.pdf"],
				},
				readiness: {
					readyCount: 1,
					reviewCount: 0,
					blockedCount: 0,
					duplicateCount: 0,
					mappingCoverage: {
						mappedRows: 1,
						totalRows: 1,
						ratio: 1,
					},
					missingAmountCount: 0,
					missingCurrencyCount: 0,
					missingDateCount: 0,
					missingCounterpartyCount: 0,
					missingDedupeCount: 0,
					invalidBookCount: 0,
					mixedMissingBusinessUsePercentCount: 0,
					badDirectionCount: 0,
				},
				items: [
					{
						canonicalKey: "txn_123",
						status: "exported",
						sourceKind: "ledger_entry",
						beancountDate: "2026-01-05",
						beancountDateSource: "posted_at",
						dateRecovery: null,
						beancountLink: "zmail-txn-123",
						messageId: null,
						sourceImportId: "import-run-1",
						reason: null,
					},
				],
				rows: [
					{
						ledgerEntry: { id: "ledger-1", canonical_key: "txn_123" },
						source: null,
						eligibility: {
							exportable: true,
							reasons: [],
							beancountDate: "2026-01-05",
							beancountDateSource: "posted_at",
							dateRecovery: null,
							confidenceUsed: 0.95,
							threshold: 0.8,
						},
						export: {
							status: "exported",
							generatedFile: "generated/2026.beancount",
							beancountLink: "zmail-txn-123",
						},
						documents: {
							emitted: ["documents/import-doc-1-statement.pdf"],
							missing: [],
						},
					},
				],
				documentsMeta: {
					pathMode: "import_run_source_file",
					copied: [
						{
							relativePath: "documents/import-doc-1-statement.pdf",
							importRunId: "import-run-1",
							importDocumentId: "import-doc-1",
							sourceDocumentRef: "statement.pdf",
							sourcePath: "/tmp/statement.pdf",
						},
					],
					missing: [
						{
							importRunId: "import-run-2",
							importDocumentId: "import-doc-2",
							sourceDocumentRef: "missing.pdf",
							sourcePath: "/tmp/missing.pdf",
							reason: "source_file_missing",
						},
					],
				},
				validation: {
					internal: {
						status: "passed",
						checks: [
							{
								name: "generated-files-sorted",
								status: "passed",
								detail: "Generated files are sorted by year ascending.",
							},
						],
						summary: {
							total: 1,
							passed: 1,
							failed: 0,
						},
					},
					beanCheck: "passed",
					beanCheckOutput: null,
					favaSmoke: "manual",
				},
			}),
		).toMatchObject({
			schemaVersion: "finance-ledger-export.v2",
			documentsMeta: { pathMode: "import_run_source_file" },
			validation: { internal: { status: "passed" } },
		});
	});
});
