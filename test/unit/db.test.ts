import { describe, expect, it } from "vitest";

import {
	seedLegacyPreSecondarySchema,
	seedStaleCanonicalMigrationHistory,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

const ACTIVE_MIGRATIONS = [
	{ name: "001_init.sql" },
	{ name: "002_connection_state.sql" },
	{ name: "003_finance_ledger_export.sql" },
	{ name: "004_finance_v3_archive.sql" },
	{ name: "005_finance_v3_target.sql" },
	{ name: "006_finance_v3_clean.sql" },
	{ name: "007_review_lanes_tax_reports.sql" },
	{ name: "008_finance_import_uploads.sql" },
	{ name: "009_unified_workflows_text_source_overrides.sql" },
];

describe("db", () => {
	it("creates the baseline schema and records all active migrations", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		dbModule.runMigrations();

		const migrations = dbModule
			.getSqlite()
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all();

		expect(migrations).toEqual(ACTIVE_MIGRATIONS);

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
		expect(tableNames).toContain("finance_import_uploads");
		expect(tableNames).toContain("finance_import_upload_files");
		expect(tableNames).toContain("finance_import_upload_pages");
		expect(tableNames).toContain("finance_import_upload_extractions");
		expect(tableNames).toContain("finance_ledger_entry_overrides");

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

		const reviewHeadColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(review_classification_heads)")
			.all() as Array<{ name: string }>;
		expect(reviewHeadColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining(["resolution_note", "decided_at"]),
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
		const financeImportRunIndexes = dbModule
			.getSqlite()
			.prepare("PRAGMA index_list(finance_import_runs)")
			.all() as Array<{ name: string; unique: number }>;
		expect(financeImportRunIndexes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "finance_import_runs_artifact_sha_idx",
					unique: 1,
				}),
				expect.objectContaining({
					name: "finance_import_runs_source_file_sha_idx",
					unique: 0,
				}),
			]),
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

		const accountColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(accounts)")
			.all() as Array<{ name: string }>;
		expect(accountColumns.map((column) => column.name)).toContain(
			"owner_principal_email",
		);
		expect(accountColumns.map((column) => column.name)).toContain(
			"connection_state",
		);

		const classificationColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(classification_results)")
			.all() as Array<{ name: string }>;
		expect(classificationColumns.map((column) => column.name)).toContain(
			"schema_version",
		);

		const labelColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(message_labels)")
			.all() as Array<{ name: string }>;
		expect(labelColumns.map((column) => column.name)).toContain(
			"schema_version",
		);

		const registryIdentityColumns = dbModule
			.getSqlite()
			.prepare("PRAGMA table_info(registry_identities)")
			.all() as Array<{ name: string }>;
		expect(registryIdentityColumns.map((column) => column.name)).toContain(
			"source_kind",
		);

		expect(tableNames).toContain("runtime_events");
		expect(tableNames).toContain("finance_ledger_entries");
		expect(tableNames).toContain("finance_model_migration_runs");
		expect(tableNames).toContain("finance_v3_clean_guard");
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

	it("leaves fully stamped databases unchanged on repeated migration runs", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite();

		dbModule.runMigrations();
		const first = sqlite
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all();

		dbModule.runMigrations();

		expect(
			sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all(),
		).toEqual(first);
		expect(first).toEqual(ACTIVE_MIGRATIONS);
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
		expect(message).not.toContain("Missing columns:");
	});

	it("builds an adoption-required message for stale migration history", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const message = dbModule.buildSchemaAdoptionRequiredMessage({
			orgId: "org-custom",
			missingColumns: ["accounts.owner_principal_email"],
			staleAppliedMigrations: ["002_secondary_schema.sql"],
		});
		expect(message).toContain(
			"pre-cleanup zmail migration history and must be adopted",
		);
		expect(message).toContain("pnpm db:migrate -- --all-orgs --adopt-history");
		expect(message).toContain(
			"pnpm db:migrate -- --org org-custom --adopt-history",
		);
		expect(message).toContain("accounts.owner_principal_email");
		expect(message).toContain("002_secondary_schema.sql");
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

	it("requires adoption for stale migration history after canonical cleanup", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		expect(() => dbModule.runMigrations()).toThrowError(
			/pre-cleanup zmail migration history and must be adopted/,
		);
		expect(() => dbModule.runMigrations()).toThrowError(
			/pnpm db:migrate -- --all-orgs --adopt-history/,
		);
	});

	it("formats adoption recovery with the explicit migration org", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({ orgId: "org-explicit" });
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		expect(() => dbModule.runMigrations("org-explicit")).toThrowError(
			/pnpm db:migrate -- --org org-explicit --adopt-history/,
		);
	});

	it("records no-op migration stamps when partial active history is already compatible", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({
			missingOwnerPrincipalEmail: false,
			migrationNames: ["001_init.sql"],
			withSampleData: true,
		});
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite();

		expect(
			sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all(),
		).toEqual([{ name: "001_init.sql" }]);

		expect(() => dbModule.runMigrations()).not.toThrow();
		expect(
			sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all(),
		).toEqual(ACTIVE_MIGRATIONS);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM accounts").get() as {
				count: number;
			},
		).toEqual({ count: 1 });
	});

	it("adopts stale canonical migration history and restamps active migrations", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({ withSampleData: true });
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite();

		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM classification_results")
				.get() as { count: number },
		).toEqual({ count: 1 });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM message_labels").get() as {
				count: number;
			},
		).toEqual({ count: 1 });

		await dbModule.adoptCanonicalMigrationHistory();

		const migrations = sqlite
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all();
		expect(migrations).toEqual(ACTIVE_MIGRATIONS);

		const accountColumns = sqlite
			.prepare("PRAGMA table_info(accounts)")
			.all() as Array<{
			name: string;
		}>;
		expect(accountColumns.map((column) => column.name)).toContain(
			"owner_principal_email",
		);

		expect(
			sqlite
				.prepare(
					"SELECT owner_principal_email FROM accounts WHERE id = 'acct-stale'",
				)
				.get(),
		).toEqual({
			owner_principal_email: "mannie@inherent.design",
		});

		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM classification_results")
				.get() as { count: number },
		).toEqual({ count: 1 });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM message_labels").get() as {
				count: number;
			},
		).toEqual({ count: 1 });
	});

	it("adopts partial active history when connection_state already exists", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({
			missingOwnerPrincipalEmail: false,
			migrationNames: ["001_init.sql"],
			withSampleData: true,
		});
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite();

		await dbModule.adoptCanonicalMigrationHistory();

		expect(
			sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all(),
		).toEqual(ACTIVE_MIGRATIONS);
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM classification_results")
				.get() as { count: number },
		).toEqual({ count: 1 });
	});

	it("repairs existing columns before replaying baseline for missing tables", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({
			missingJobLaneColumns: true,
			withSampleData: true,
		});
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite();
		sqlite.exec("DROP TABLE tax_report_runs;");

		await dbModule.adoptCanonicalMigrationHistory();

		const jobColumns = sqlite
			.prepare("PRAGMA table_info(jobs)")
			.all() as Array<{
			name: string;
		}>;
		expect(jobColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"lane",
				"priority",
				"run_after_at",
				"claim_owner",
			]),
		);
		expect(
			sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tax_report_runs'",
				)
				.get(),
		).toEqual({ name: "tax_report_runs" });
	});

	it("adds and backfills connection_state during canonical adoption", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({
			missingConnectionState: true,
			withSampleData: true,
		});
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite();
		sqlite.exec(`
			INSERT INTO accounts (
				id,
				label,
				email_address,
				provider_kind,
				sync_enabled,
				sync_status,
				source_truth,
				selected_mailbox,
				last_synced_at,
				last_error,
				created_at,
				updated_at
			)
			VALUES
				(
					'acct-config',
					'Config',
					'config@example.com',
					'gmail',
					1,
					'idle',
					'corpus_mirror',
					'[Gmail]/All Mail',
					NULL,
					'Google OAuth client credentials were rejected by Google. retry',
					'2026-01-01T00:00:00.000Z',
					'2026-01-01T00:00:00.000Z'
				),
				(
					'acct-reconnect',
					'Reconnect',
					'reconnect@example.com',
					'gmail',
					1,
					'needs_reconnect',
					'corpus_mirror',
					'[Gmail]/All Mail',
					NULL,
					NULL,
					'2026-01-01T00:00:00.000Z',
					'2026-01-01T00:00:00.000Z'
				),
				(
					'acct-paused',
					'Paused',
					'paused@example.com',
					'gmail',
					0,
					'idle',
					'corpus_mirror',
					'[Gmail]/All Mail',
					NULL,
					NULL,
					'2026-01-01T00:00:00.000Z',
					'2026-01-01T00:00:00.000Z'
				);
		`);

		await dbModule.adoptCanonicalMigrationHistory();

		const states = sqlite
			.prepare("SELECT id, connection_state FROM accounts ORDER BY id")
			.all();
		expect(states).toEqual([
			{ id: "acct-config", connection_state: "config_error" },
			{ id: "acct-paused", connection_state: "paused" },
			{ id: "acct-reconnect", connection_state: "needs_reconnect" },
			{ id: "acct-stale", connection_state: "connected" },
		]);
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
