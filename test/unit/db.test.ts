import { describe, expect, it } from "vitest";

import { createTestRuntime } from "#/test/helpers/runtime";

describe("db", () => {
	it("creates migrations and the live-sync tables", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		dbModule.runMigrations();

		const migrations = dbModule
			.getSqlite()
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all();

		expect(migrations.length).toBeGreaterThan(0);

		// account_sync_state and message_sources tables exist after migration
		const tables = dbModule
			.getSqlite()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("account_sync_state");
		expect(tableNames).toContain("message_sources");

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
		const syncColumnNames = syncColumns.map((column) => column.name);

		expect(syncColumnNames).toContain("latest_uid_cursor");
		expect(syncColumnNames).toContain("earliest_uid_cursor");
		expect(syncColumnNames).toContain("backfill_snapshot_uid");
		expect(syncColumnNames).toContain("backfill_next_uid");
		expect(syncColumnNames).toContain("last_bootstrap_started_at");
		expect(syncColumnNames).toContain("last_bootstrap_completed_at");
		expect(syncColumnNames).toContain("last_backfill_sync_at");
		expect(syncColumnNames).toContain("backfill_completed_at");
		expect(syncColumnNames).not.toContain("last_seen_uid");
		expect(syncColumnNames).not.toContain("last_full_sync_started_at");
		expect(syncColumnNames).not.toContain("last_full_sync_completed_at");
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

	it("restores a missing bookkeeping row for migration 002 without replaying it", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		dbModule.runMigrations();
		const sqlite = dbModule.getSqlite();
		sqlite
			.prepare("DELETE FROM _migrations WHERE name = ?")
			.run("002_jobs_live_cleanup.sql");

		expect(() => dbModule.runMigrations()).not.toThrow();
		expect(
			sqlite
				.prepare("SELECT name FROM _migrations WHERE name = ?")
				.get("002_jobs_live_cleanup.sql"),
		).toEqual({ name: "002_jobs_live_cleanup.sql" });
	});

	it("restores a missing bookkeeping row for migration 003 without replaying it", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		dbModule.runMigrations();
		const sqlite = dbModule.getSqlite();
		sqlite
			.prepare("DELETE FROM _migrations WHERE name = ?")
			.run("003_account_sync_state_resumable_backfill.sql");

		expect(() => dbModule.runMigrations()).not.toThrow();
		expect(
			sqlite
				.prepare("SELECT name FROM _migrations WHERE name = ?")
				.get("003_account_sync_state_resumable_backfill.sql"),
		).toEqual({ name: "003_account_sync_state_resumable_backfill.sql" });
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
