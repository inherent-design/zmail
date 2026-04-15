import { describe, expect, it } from "vitest";

import {
	seedLegacyPreSecondarySchema,
	seedSecondaryTablesMissingSchema,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("db", () => {
	it("creates the baseline schema and records both migrations", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		dbModule.runMigrations();

		const migrations = dbModule
			.getSqlite()
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all();

		expect(migrations).toEqual([
			{ name: "001_init.sql" },
			{ name: "002_secondary_schema.sql" },
		]);

		const tables = dbModule
			.getSqlite()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("account_sync_state");
		expect(tableNames).toContain("conversations");
		expect(tableNames).toContain("message_sources");
		expect(tableNames).toContain("message_secondary_results");
		expect(tableNames).toContain("message_secondary_heads");
		expect(tableNames).toContain("registry_identities");
		expect(tableNames).toContain("registry_institutions");
		expect(tableNames).toContain("registry_financial_accounts");
		expect(tableNames).toContain("registry_sender_rules");
		expect(tableNames).toContain("registry_import_state");
		expect(tableNames).toContain("finance_event_candidates");
		expect(tableNames).toContain("finance_document_candidates");
		expect(tableNames).toContain("finance_event_evidence");

		const messageColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;
		expect(messageColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"ingested_at",
				"conversation_id",
				"body_text_primary",
				"body_text_forwarded",
				"body_extraction_strategy",
				"parse_error_reason",
			]),
		);

		const conversationColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(conversations)")
			.all() as Array<{ name: string }>;
		expect(conversationColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"id",
				"account_id",
				"gmail_thread_id",
				"first_message_received_at",
				"last_message_received_at",
				"message_count",
				"created_at",
				"updated_at",
			]),
		);
		const messageIndexes = dbModule
			.getSqlite()
			.prepare("PRAGMA index_list(messages)")
			.all() as Array<{ name: string }>;
		expect(messageIndexes.map((index) => index.name)).toContain(
			"messages_conversation_idx",
		);
		const conversationIndexes = dbModule
			.getSqlite()
			.prepare("PRAGMA index_list(conversations)")
			.all() as Array<{ unique: number }>;
		expect(conversationIndexes.some((index) => index.unique === 1)).toBe(true);

		const jobColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(jobs)")
			.all() as Array<{ name: string }>;
		const jobColumnNames = jobColumns.map((column) => column.name);

		expect(jobColumnNames).not.toContain("batch_id");
		expect(jobColumnNames).not.toContain("input_file_path");
		expect(jobColumnNames).not.toContain("output_file_path");
		expect(jobColumnNames).not.toContain("error_file_path");

		const syncColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(account_sync_state)")
			.all() as Array<{ name: string }>;
		expect(syncColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"latest_uid_cursor",
				"earliest_uid_cursor",
				"backfill_snapshot_uid",
				"backfill_next_uid",
				"last_bootstrap_started_at",
				"last_bootstrap_completed_at",
				"last_backfill_sync_at",
				"backfill_completed_at",
			]),
		);
	});

	it("parses safe json with fallback and exposes fileName", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		expect(dbModule.safeJsonParse('{"ok":true}', { ok: false })).toEqual({
			ok: true,
		});
		expect(dbModule.safeJsonParse("bad-json", { ok: false })).toEqual({
			ok: false,
		});
		expect(dbModule.jsonText({ ok: true })).toBe('{"ok":true}');
		expect(dbModule.fileName("/tmp/file.txt")).toBe("file.txt");
	});

	it("builds a reset-required message without schema details when none are supplied", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const message = dbModule.buildSchemaResetRequiredMessage();
		expect(message).toContain(
			"This local database predates the rewritten zmail baseline",
		);
		expect(message).toContain("1. pnpm db:reset:messages");
		expect(message).toContain("1. pnpm db:reset");
		expect(message).not.toContain("Missing tables:");
		expect(message).not.toContain("Missing messages columns:");
	});

	it("fails fast when a local DB predates the rewritten baseline", async () => {
		const runtime = await createTestRuntime();
		await seedLegacyPreSecondarySchema();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		expect(() => dbModule.runMigrations()).toThrowError(
			/This local database predates the rewritten zmail baseline/,
		);
		expect(() => dbModule.runMigrations()).toThrowError(
			/Missing messages columns: ingested_at/,
		);
		expect(() => dbModule.runMigrations()).toThrowError(/parse_error_reason/);
	});

	it("repairs mixed databases that only need the secondary schema tables", async () => {
		const runtime = await createTestRuntime();
		await seedSecondaryTablesMissingSchema();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		expect(() => dbModule.runMigrations()).not.toThrow();

		const migrations = dbModule
			.getSqlite()
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all();
		expect(migrations).toEqual([
			{ name: "001_init.sql" },
			{ name: "002_secondary_schema.sql" },
		]);

		const tables = dbModule
			.getSqlite()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		expect(tables.map((table) => table.name)).toEqual(
			expect.arrayContaining([
				"message_secondary_results",
				"message_secondary_heads",
				"registry_import_state",
				"finance_event_candidates",
				"finance_document_candidates",
				"finance_event_evidence",
			]),
		);
	});

	it("accounts table uses the live-only schema with provider_kind and sync columns", async () => {
		await createTestRuntime();
		const { bootDb } = await import("#/test/helpers/db");
		const { db } = await bootDb({ seedDefaultAccount: true });

		const account = await db
			.selectFrom("accounts")
			.selectAll()
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();

		expect(account.provider_kind).toBe("gmail");
		expect(account.sync_enabled).toBe(1);
		expect(account.sync_status).toBe("idle");
		expect(account.source_truth).toBe("corpus_mirror");
		expect(account.selected_mailbox).toBe("[Gmail]/All Mail");
		expect(account.updated_at).toBeTruthy();
	});

	it("enforces unique account email addresses", async () => {
		await createTestRuntime();
		const { bootDb } = await import("#/test/helpers/db");
		const { db } = await bootDb({ seedDefaultAccount: true });

		await expect(
			db
				.insertInto("accounts")
				.values({
					id: "acct-2",
					label: "Duplicate",
					email_address: "acct-1@example.com",
					provider_kind: "gmail",
					sync_enabled: 1,
					sync_status: "idle",
					source_truth: "corpus_mirror",
					selected_mailbox: "[Gmail]/All Mail",
					last_synced_at: null,
					last_error: null,
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-01T00:00:00.000Z",
				})
				.execute(),
		).rejects.toThrow(/accounts_email_address_idx|accounts.email_address/);
	});
});
