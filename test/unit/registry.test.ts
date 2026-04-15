import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	bootDb,
	insertMessageRow,
	insertSecondaryResultRow,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("registry", () => {
	it("imports registry yaml, marks finance heads stale, and matches known facts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const messageId = await insertMessageRow(db, {
			accountId: "acct-1",
			subject: "Checking account statement ending 4242",
			bodyTextNormalized: "Monthly statement for business checking ending 4242",
			contentSha256: "content-sha",
		});
		await insertSecondaryResultRow(db, {
			messageId,
			status: "ready",
			contentSha256: "content-sha",
			registrySha256: "registry-old",
		});

		const registryDir = join(runtime.dataDir, "operator", "registry");
		await mkdir(registryDir, { recursive: true });
		await writeFile(
			join(registryDir, "identities.yaml"),
			[
				"- id: owner-business",
				"  kind: business",
				"  displayName: Inherent Design",
				'  aliases: ["inherent design"]',
				'  emailAddresses: ["acct-1@example.com"]',
				'  domains: ["example.com"]',
			].join("\n"),
		);
		await writeFile(
			join(registryDir, "institutions.yaml"),
			[
				"- id: institution-chase",
				"  displayName: Chase",
				'  aliases: ["chase"]',
				'  domains: ["chase.com"]',
			].join("\n"),
		);
		await writeFile(
			join(registryDir, "financial-accounts.yaml"),
			[
				"- id: account-business-checking",
				"  institutionId: institution-chase",
				"  ownerIdentityId: owner-business",
				"  displayName: Business Checking",
				'  aliases: ["business checking"]',
				'  accountLast4: "4242"',
			].join("\n"),
		);
		await writeFile(
			join(registryDir, "sender-rules.yaml"),
			[
				"- id: sender-rule-chase",
				"  senderPattern: chase.com",
				"  domain: chase.com",
				"  institutionId: institution-chase",
				"  financialAccountId: account-business-checking",
				"  priority: 10",
			].join("\n"),
		);

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const imported = await registry.importOperatorRegistry();
		const snapshot = await registry.loadOperatorRegistry();
		const matched = await registry.matchRegistryForMessage({
			accountLabel: "Test Account",
			accountEmail: "acct-1@example.com",
			senderAddress: "alerts@chase.com",
			subject: "Business checking statement 4242",
			bodyText: "Statement available for business checking ending 4242",
			rootLabel: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "neither",
					owner: "business",
					accountHint: "business checking",
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
					overall: 1,
					finance: 1,
					social: 1,
					risk: 1,
				},
				explanation: "ok",
			},
		});
		const head = await db
			.selectFrom("message_secondary_heads")
			.select(["status", "registry_sha256"])
			.where("message_id", "=", messageId)
			.executeTakeFirstOrThrow();

		expect(imported.counts).toEqual({
			identities: 1,
			institutions: 1,
			financialAccounts: 1,
			senderRules: 1,
		});
		expect(snapshot.identities).toHaveLength(1);
		expect(snapshot.institutions).toHaveLength(1);
		expect(snapshot.financialAccounts).toHaveLength(1);
		expect(snapshot.senderRules).toHaveLength(1);
		expect(head.status).toBe("stale");
		expect(head.registry_sha256).toBe("registry-old");
		expect(matched.identities.map((row) => row.id)).toContain("owner-business");
		expect(matched.institutions.map((row) => row.id)).toContain(
			"institution-chase",
		);
		expect(matched.financialAccounts.map((row) => row.id)).toContain(
			"account-business-checking",
		);
	});

	it("treats missing and empty registry yaml files as empty inputs", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });
		const registryDir = join(runtime.dataDir, "operator", "registry");
		await mkdir(registryDir, { recursive: true });
		await writeFile(join(registryDir, "identities.yaml"), "");

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const imported = await registry.importOperatorRegistry();

		expect(imported.counts).toEqual({
			identities: 0,
			institutions: 0,
			financialAccounts: 0,
			senderRules: 0,
		});
	});

	it("imports registry yaml rows with optional last4 and domain omitted", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });
		const registryDir = join(runtime.dataDir, "operator", "registry");
		await mkdir(registryDir, { recursive: true });
		await writeFile(join(registryDir, "identities.yaml"), "[]\n");
		await writeFile(join(registryDir, "institutions.yaml"), "[]\n");
		await writeFile(
			join(registryDir, "financial-accounts.yaml"),
			[
				"- id: account-optional-fields",
				"  displayName: Optional Account",
				"  aliases: []",
			].join("\n"),
		);
		await writeFile(
			join(registryDir, "sender-rules.yaml"),
			[
				"- id: rule-optional-domain",
				"  senderPattern: Receipt Ready ",
				"  priority: 4",
			].join("\n"),
		);

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const imported = await registry.importOperatorRegistry();
		const snapshot = await registry.loadOperatorRegistry();

		expect(imported.counts).toEqual({
			identities: 0,
			institutions: 0,
			financialAccounts: 1,
			senderRules: 1,
		});
		expect(snapshot.financialAccounts[0]?.accountLast4).toBeNull();
		expect(snapshot.senderRules[0]).toMatchObject({
			id: "rule-optional-domain",
			senderPattern: "receipt ready",
			domain: null,
		});
	});

	it("loads an empty registry and matches sender rules through search text", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const empty = await registry.loadOperatorRegistry();
		expect(empty.identities).toEqual([]);
		expect(empty.institutions).toEqual([]);
		expect(empty.financialAccounts).toEqual([]);
		expect(empty.senderRules).toEqual([]);
		expect(registry.extractDomain("not-an-email")).toBeNull();
		expect(registry.extractDomain("alerts@")).toBeNull();
		expect(registry.extractDomain("alerts@example.com")).toBe("example.com");

		await db
			.insertInto("registry_identities")
			.values({
				id: "identity-owner",
				kind: "business",
				display_name: "Owner",
				aliases_json: JSON.stringify(["owner"]),
				email_addresses_json: JSON.stringify(["acct-1@example.com"]),
				domains_json: JSON.stringify(["example.com"]),
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_institutions")
			.values({
				id: "institution-amex",
				display_name: "American Express",
				aliases_json: JSON.stringify(["amex"]),
				domains_json: JSON.stringify(["americanexpress.com"]),
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_financial_accounts")
			.values({
				id: "account-amex",
				institution_id: "institution-amex",
				owner_identity_id: "identity-owner",
				display_name: "Amex Gold",
				aliases_json: JSON.stringify(["amex gold"]),
				account_mask: null,
				account_last4: "4444",
				account_type: null,
				currency: null,
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_sender_rules")
			.values([
				{
					id: "rule-text-match",
					sender_pattern: "statement available",
					domain: null,
					owner_identity_id: "identity-owner",
					institution_id: "institution-amex",
					financial_account_id: "account-amex",
					message_kind_hint: null,
					priority: 5,
					notes: null,
				},
				{
					id: "rule-owner-only",
					sender_pattern: "statement available",
					domain: null,
					owner_identity_id: "identity-owner",
					institution_id: null,
					financial_account_id: null,
					message_kind_hint: null,
					priority: 7,
					notes: null,
				},
				{
					id: "rule-domain-match",
					sender_pattern: "updates.example.net",
					domain: null,
					owner_identity_id: "identity-owner",
					institution_id: "institution-amex",
					financial_account_id: "account-amex",
					message_kind_hint: null,
					priority: 10,
					notes: null,
				},
				{
					id: "rule-domain-mismatch",
					sender_pattern: "statement available",
					domain: "other.example.com",
					owner_identity_id: "identity-owner",
					institution_id: "institution-amex",
					financial_account_id: "account-amex",
					message_kind_hint: null,
					priority: 20,
					notes: null,
				},
			])
			.execute();
		await db
			.insertInto("registry_import_state")
			.values({
				key: "operator_registry",
				combined_sha256: "registry-live",
				source_dir: "/tmp/registry",
				counts_json: JSON.stringify({
					identities: 1,
					institutions: 1,
					financialAccounts: 1,
					senderRules: 2,
				}),
				imported_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const matched = await registry.matchRegistryForMessage({
			accountLabel: "Test Account",
			accountEmail: "acct-1@example.com",
			senderAddress: "noreply@updates.example.net",
			subject: "Statement available now",
			bodyText: "Your Amex Gold statement is available. Account ending 4444.",
			rootLabel: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "neither",
					owner: "business",
					accountHint: "amex gold",
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
					overall: 1,
					finance: 1,
					social: 1,
					risk: 1,
				},
				explanation: "ok",
			},
		});
		const linkedMatch = await registry.matchRegistryForMessage({
			accountLabel: "Test Account",
			accountEmail: "owner@example.com",
			senderAddress: "alerts@americanexpress.com",
			subject: "Monthly statement available",
			bodyText: "A new statement is available.",
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
					overall: 1,
					finance: 1,
					social: 1,
					risk: 1,
				},
				explanation: "ok",
			},
		});

		expect(matched.sha256).toHaveLength(64);
		expect(linkedMatch.sha256).toBe(matched.sha256);
		expect(matched.identities.map((row) => row.id)).toEqual(["identity-owner"]);
		expect(matched.institutions.map((row) => row.id)).toEqual([
			"institution-amex",
		]);
		expect(matched.financialAccounts.map((row) => row.id)).toEqual([
			"account-amex",
		]);
		expect(matched.senderRules.map((row) => row.id)).toEqual([
			"rule-text-match",
			"rule-owner-only",
			"rule-domain-match",
		]);
		expect(linkedMatch.identities.map((row) => row.id)).toContain(
			"identity-owner",
		);
		expect(linkedMatch.institutions.map((row) => row.id)).toContain(
			"institution-amex",
		);
		expect(linkedMatch.financialAccounts.map((row) => row.id)).toContain(
			"account-amex",
		);
	});

	it("matches alias-only identities and owner-linked accounts without last4 digits", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });

		await db
			.insertInto("registry_identities")
			.values({
				id: "identity-alias-only",
				kind: "business",
				display_name: "Project Lion LLC",
				aliases_json: JSON.stringify(["project lion"]),
				email_addresses_json: JSON.stringify([]),
				domains_json: JSON.stringify([]),
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_financial_accounts")
			.values({
				id: "account-owner-linked",
				institution_id: null,
				owner_identity_id: "identity-alias-only",
				display_name: "Owner Linked Account",
				aliases_json: JSON.stringify([]),
				account_mask: null,
				account_last4: null,
				account_type: null,
				currency: null,
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_financial_accounts")
			.values({
				id: "account-unmatched-empty",
				institution_id: null,
				owner_identity_id: null,
				display_name: "Unmatched Empty Account",
				aliases_json: JSON.stringify([]),
				account_mask: null,
				account_last4: null,
				account_type: null,
				currency: null,
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_import_state")
			.values({
				key: "operator_registry",
				combined_sha256: "registry-alias-only",
				source_dir: "/tmp/registry",
				counts_json: JSON.stringify({
					identities: 1,
					institutions: 0,
					financialAccounts: 1,
					senderRules: 0,
				}),
				imported_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const matched = await registry.matchRegistryForMessage({
			accountLabel: "Unrelated Account",
			accountEmail: "different@example.org",
			senderAddress: "receipts@vendor.test",
			subject: "Project Lion expense receipt",
			bodyText: "Project Lion reimbursable software expense attached.",
			rootLabel: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: null,
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
					overall: 1,
					finance: 1,
					social: 1,
					risk: 1,
				},
				explanation: "ok",
			},
		});

		expect(matched.identities.map((row) => row.id)).toEqual([
			"identity-alias-only",
		]);
		expect(matched.institutions).toEqual([]);
		expect(matched.financialAccounts.map((row) => row.id)).toEqual([
			"account-owner-linked",
		]);
	});

	it("loads registry rows without import state and derives a fallback registry hash", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("registry_identities")
			.values({
				id: "identity-no-import-state",
				kind: "business",
				display_name: "Fallback Identity",
				aliases_json: JSON.stringify([]),
				email_addresses_json: JSON.stringify([]),
				domains_json: JSON.stringify([]),
				tax_owner_hint: null,
				notes: null,
			})
			.execute();

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const snapshot = await registry.loadOperatorRegistry();

		expect(snapshot.identities.map((row) => row.id)).toEqual([
			"identity-no-import-state",
		]);
		expect(snapshot.importedAt).toBeNull();
		expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("handles invalid sender domains while matching sender rules with null references", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("registry_institutions")
			.values({
				id: "institution-unmatched",
				display_name: "Unmatched Institution",
				aliases_json: JSON.stringify([]),
				domains_json: JSON.stringify(["institution.test"]),
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_sender_rules")
			.values({
				id: "rule-null-refs",
				sender_pattern: "receipt ready",
				domain: null,
				owner_identity_id: null,
				institution_id: null,
				financial_account_id: null,
				message_kind_hint: null,
				priority: 1,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_import_state")
			.values({
				key: "operator_registry",
				combined_sha256: "registry-missing-refs",
				source_dir: "/tmp/registry",
				counts_json: JSON.stringify({
					identities: 0,
					institutions: 1,
					financialAccounts: 0,
					senderRules: 1,
				}),
				imported_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const matched = await registry.matchRegistryForMessage({
			accountLabel: "Test Account",
			accountEmail: "acct-1@example.com",
			senderAddress: "not-an-email",
			subject: "Receipt ready",
			bodyText: "Receipt ready for review.",
			rootLabel: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: null,
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
					overall: 1,
					finance: 1,
					social: 1,
					risk: 1,
				},
				explanation: "ok",
			},
		});

		expect(matched.senderRules.map((row) => row.id)).toEqual([
			"rule-null-refs",
		]);
		expect(matched.identities).toEqual([]);
		expect(matched.institutions).toEqual([]);
		expect(matched.financialAccounts).toEqual([]);
	});

	it("normalizes null sender fields and missing account domains safely", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("registry_identities")
			.values({
				id: "identity-domain-only",
				kind: "business",
				display_name: "Domain Only",
				aliases_json: JSON.stringify([]),
				email_addresses_json: JSON.stringify([]),
				domains_json: JSON.stringify(["example.com"]),
				tax_owner_hint: null,
				notes: null,
			})
			.execute();
		await db
			.insertInto("registry_import_state")
			.values({
				key: "operator_registry",
				combined_sha256: "registry-null-fields",
				source_dir: "/tmp/registry",
				counts_json: JSON.stringify({
					identities: 1,
					institutions: 0,
					financialAccounts: 0,
					senderRules: 0,
				}),
				imported_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const matched = await registry.matchRegistryForMessage({
			accountLabel: "No Domain Account",
			accountEmail: "localpart-only",
			senderAddress: null,
			subject: null,
			bodyText: "No registry aliases here.",
			rootLabel: null,
		});

		expect(matched.identities).toEqual([]);
		expect(matched.institutions).toEqual([]);
		expect(matched.financialAccounts).toEqual([]);
		expect(matched.senderRules).toEqual([]);
	});

	it("materializes empty registry yaml files on first load", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });

		const registry =
			await runtime.importFresh<typeof import("#/lib/registry")>(
				"#/lib/registry",
			);
		const snapshot = await registry.loadOperatorRegistry();
		const registryDir = join(runtime.dataDir, "operator", "registry");

		expect(snapshot.identities).toEqual([]);
		expect(snapshot.institutions).toEqual([]);
		expect(snapshot.financialAccounts).toEqual([]);
		expect(snapshot.senderRules).toEqual([]);
		expect(existsSync(join(registryDir, "identities.yaml"))).toBe(true);
		expect(existsSync(join(registryDir, "institutions.yaml"))).toBe(true);
		expect(existsSync(join(registryDir, "financial-accounts.yaml"))).toBe(
			true,
		);
		expect(existsSync(join(registryDir, "sender-rules.yaml"))).toBe(true);
	});
});
