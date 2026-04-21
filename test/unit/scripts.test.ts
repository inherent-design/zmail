import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertConversationRow,
	insertMessageLabelRow,
	insertMessageRow,
	insertSecondaryResultRow,
	seedLegacyPreSecondarySchema,
	seedStaleCanonicalMigrationHistory,
	seedTestAccount,
} from "#/test/helpers/db";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

interface MockCodexLoginOptions {
	onAuth?: (input: { instructions: string; url: string }) => void;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	onPrompt?: (input: { message: string }) => Promise<string>;
}

const ACTIVE_MIGRATIONS = [
	{ name: "001_init.sql" },
	{ name: "002_connection_state.sql" },
	{ name: "003_finance_ledger_export.sql" },
	{ name: "004_finance_v3_archive.sql" },
	{ name: "005_finance_v3_target.sql" },
	{ name: "006_finance_v3_clean.sql" },
	{ name: "007_review_lanes_tax_reports.sql" },
	{ name: "008_finance_import_uploads.sql" },
];

const loginOpenAICodex = vi.fn(async () => ({
	refresh: "refresh",
	access: "access",
	expires: Date.now() + 60_000,
}));

function buildFinanceArtifact(artifactSha256: string) {
	return {
		schemaVersion: "finance-source-import.v1",
		sourceKind: "pdf",
		sourceFile: {
			absolutePath: "/tmp/statement.pdf",
			sha256: "statement-sha",
			filename: "statement.pdf",
			importedAt: "2026-04-15T00:00:00.000Z",
		},
		artifactSha256,
		extractor: {
			runner: "pytest",
			model: "claude-opus",
			promptVersion: "finance-source-import.v1",
			extractedTextHash: "text-sha",
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
	};
}

vi.mock("@mariozechner/pi-ai/oauth", () => ({
	loginOpenAICodex,
}));

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: vi.fn(async () => "code"),
		close: vi.fn(),
	})),
}));

describe("scripts", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("#/lib/db");
		vi.doUnmock("#/lib/log");
		vi.doUnmock("#/lib/pi");
	});

	it("detects direct execution", async () => {
		const { isDirectExecution } = await import("#/scripts/_shared");
		expect(isDirectExecution(import.meta.url)).toBe(false);
	});

	it("handles missing argv and runCli failures with traced output", async () => {
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const { isDirectExecution, runCli } = await import("#/scripts/_shared");
		const originalArgv = process.argv;
		process.argv = ["node"];

		expect(isDirectExecution(import.meta.url)).toBe(false);

		process.argv = ["node", "/tmp/tool.ts"];
		runCli(
			async () => {
				throw new Error("boom");
			},
			pathToFileURL("/tmp/tool.ts").href,
			"test:fail",
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(process.exitCode).toBe(1);
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "cli.command.start",
				}),
				expect.objectContaining({
					type: "fail",
					event: "cli.command.fail",
				}),
			]),
		);
		process.exitCode = undefined;
		process.argv = originalArgv;
	});

	it("runCli emits traced start and completion events", async () => {
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const { runCli } = await import("#/scripts/_shared");
		const originalArgv = process.argv;
		process.argv = ["node", "/tmp/success.ts"];

		runCli(
			async () => undefined,
			pathToFileURL("/tmp/success.ts").href,
			"test:ok",
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "cli.command.start",
				}),
				expect.objectContaining({
					type: "complete",
					event: "cli.command.complete",
				}),
			]),
		);

		process.argv = originalArgv;
	});

	it("writes subscription credentials with pi:connect", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const readline = await import("node:readline/promises");
		const createInterface = vi.mocked(readline.createInterface);

		loginOpenAICodex.mockImplementationOnce((async (
			options: MockCodexLoginOptions,
		) => {
			options.onAuth?.({
				instructions: "follow the instructions",
				url: "https://example.com",
			});
			options.onProgress?.("waiting");
			await options.onManualCodeInput?.();
			await options.onPrompt?.({ message: "Enter value" });
			return {
				refresh: "refresh",
				access: "access",
				expires: Date.now() + 60_000,
			};
		}) as never);

		const script = await runtime.importFresh<
			typeof import("#/scripts/pi-connect-subscription")
		>("#/scripts/pi-connect-subscription");
		await script.main();

		const stored = JSON.parse(
			await readFile(config.PI_SUBSCRIPTION_PATH, "utf8"),
		);
		expect(stored.provider).toBe("openai-subscription");
		expect(loginOpenAICodex).toHaveBeenCalled();
		expect(createInterface).toHaveBeenCalled();
	});

	it("uses a child trace when pi:connect receives one directly", async () => {
		const runtime = await createTestRuntime();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const script = await runtime.importFresh<
			typeof import("#/scripts/pi-connect-subscription")
		>("#/scripts/pi-connect-subscription");
		const trace = log.module.startTrace({
			kind: "cli",
			operation: "test-root",
		});
		await script.main(trace);

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "child",
					fields: expect.objectContaining({
						kind: "cli",
						operation: "pi:connect",
					}),
				}),
			]),
		);
	});

	it("runs migrations script for the default org when no org DBs exist yet", async () => {
		const runtime = await createTestRuntime();
		const script =
			await runtime.importFresh<typeof import("#/scripts/migrate")>(
				"#/scripts/migrate",
			);
		await script.main();

		const db = await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const tables = db
			.getSqlite()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("accounts");
		expect(tableNames).toContain("account_sync_state");
		expect(
			db
				.getSqlite()
				.prepare("SELECT name FROM _migrations ORDER BY name")
				.all(),
		).toEqual(ACTIVE_MIGRATIONS);
	});

	it("runs migrations across all discovered org databases by default", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		dbModule.getSqlite("org-a");
		dbModule.getSqlite("org-b");

		const script =
			await runtime.importFresh<typeof import("#/scripts/migrate")>(
				"#/scripts/migrate",
			);
		await script.main();

		expect(
			dbModule
				.getSqlite("org-a")
				.prepare("SELECT name FROM _migrations ORDER BY name")
				.all(),
		).toEqual(ACTIVE_MIGRATIONS);
		expect(
			dbModule
				.getSqlite("org-b")
				.prepare("SELECT name FROM _migrations ORDER BY name")
				.all(),
		).toEqual(ACTIVE_MIGRATIONS);
	});

	it("adopts stale history for a selected org and preserves existing rows", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({
			orgId: "org-stale",
			withSampleData: true,
		});
		const script =
			await runtime.importFresh<typeof import("#/scripts/migrate")>(
				"#/scripts/migrate",
			);
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const sqlite = dbModule.getSqlite("org-stale");

		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM classification_results")
				.get(),
		).toEqual({ count: 1 });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM message_labels").get(),
		).toEqual({ count: 1 });

		await script.main(undefined, [
			"node",
			"scripts/migrate.ts",
			"--",
			"--org",
			"org-stale",
			"--adopt-history",
		]);

		expect(
			sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all(),
		).toEqual(ACTIVE_MIGRATIONS);
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
				.get(),
		).toEqual({ count: 1 });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM message_labels").get(),
		).toEqual({ count: 1 });
	});

	it("adopts all discovered org histories idempotently", async () => {
		const runtime = await createTestRuntime();
		await seedStaleCanonicalMigrationHistory({
			orgId: "org-stale",
			missingOwnerPrincipalEmail: false,
			migrationNames: ["001_init.sql"],
			withSampleData: true,
		});
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		dbModule.runMigrations("org-ready");
		const script =
			await runtime.importFresh<typeof import("#/scripts/migrate")>(
				"#/scripts/migrate",
			);

		await script.main(undefined, [
			"node",
			"scripts/migrate.ts",
			"--",
			"--all-orgs",
			"--adopt-history",
		]);
		await script.main(undefined, [
			"node",
			"scripts/migrate.ts",
			"--",
			"--all-orgs",
			"--adopt-history",
		]);
		await script.main(undefined, [
			"node",
			"scripts/migrate.ts",
			"--",
			"--all-orgs",
		]);

		expect(
			dbModule
				.getSqlite("org-stale")
				.prepare("SELECT name FROM _migrations ORDER BY name")
				.all(),
		).toEqual(ACTIVE_MIGRATIONS);
		expect(
			dbModule
				.getSqlite("org-ready")
				.prepare("SELECT name FROM _migrations ORDER BY name")
				.all(),
		).toEqual(ACTIVE_MIGRATIONS);
		expect(
			dbModule
				.getSqlite("org-stale")
				.prepare("SELECT COUNT(*) AS count FROM accounts")
				.get(),
		).toEqual({ count: 1 });
	});

	it("resets only jobs with db:reset:jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("jobs")
			.values({
				id: "job-reset-jobs",
				kind: "sync_account_delta",
				scope_type: "account",
				scope_id: "acct-1",
				status: "complete",
				model: null,
				prompt_version: null,
				request_count: 0,
				success_count: 0,
				error_count: 0,
				claimed_at: null,
				lease_expires_at: null,
				attempts: 0,
				last_error: null,
				created_at: "2026-01-01T00:00:00.000Z",
				started_at: null,
				finished_at: null,
				meta_json: "{}",
			})
			.execute();

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script =
			await runtime.importFresh<typeof import("#/scripts/db-reset")>(
				"#/scripts/db-reset",
			);
		await script.main(undefined, [
			"node",
			"scripts/db-reset.ts",
			"--org",
			"local",
			"jobs",
		]);

		const summary = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(summary).toEqual({
			mode: "jobs",
			orgId: "local",
			deletedJobs: 1,
			hadDatabase: true,
		});
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		expect(
			await dbModule.getDb().selectFrom("jobs").select(["id"]).execute(),
		).toEqual([]);
		logSpy.mockRestore();
	});

	it("resets messages while preserving accounts and oauth tokens", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		const configModule =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await seedTestAccount(db, {
			id: "acct-1",
			label: "Primary",
			emailAddress: "acct-1@example.com",
			syncEnabled: 1,
			syncStatus: "backfilling",
		});
		await seedTestAccount(db, {
			id: "acct-2",
			label: "Paused",
			emailAddress: "acct-2@example.com",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await insertMessageRow(db, {
			id: "msg-reset-messages",
			accountId: "acct-1",
		});
		await db
			.insertInto("jobs")
			.values({
				id: "job-reset-messages",
				kind: "classify_account_backlog",
				scope_type: "account",
				scope_id: "acct-1",
				status: "queued",
				model: null,
				prompt_version: null,
				request_count: 0,
				success_count: 0,
				error_count: 0,
				claimed_at: null,
				lease_expires_at: null,
				attempts: 0,
				last_error: null,
				created_at: "2026-01-01T00:00:00.000Z",
				started_at: null,
				finished_at: null,
				meta_json: "{}",
			})
			.execute();

		const acct1Dir = configModule.accountDir("acct-1");
		const acct2Dir = configModule.accountDir("acct-2");
		const acct1RawDir = join(acct1Dir, "raw");
		const acct2RawDir = join(acct2Dir, "raw");
		mkdirSync(acct1RawDir, { recursive: true });
		mkdirSync(acct2RawDir, { recursive: true });
		writeFileSync(join(acct1Dir, "google-oauth.json"), '{"token":"acct-1"}');
		writeFileSync(join(acct2Dir, "google-oauth.json"), '{"token":"acct-2"}');
		writeFileSync(join(acct1RawDir, "gm-reset-1.eml"), "raw-one");
		writeFileSync(join(acct2RawDir, "gm-reset-2.eml"), "raw-two");

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script =
			await runtime.importFresh<typeof import("#/scripts/db-reset")>(
				"#/scripts/db-reset",
			);
		await script.main(undefined, [
			"node",
			"scripts/db-reset.ts",
			"--org",
			"local",
			"messages",
		]);

		const summary = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(summary).toEqual({
			mode: "messages",
			orgId: "local",
			preservedAccounts: 2,
			queuedFullSyncJobs: 1,
			preservedOAuthTokens: true,
			deletedRawMessageDirs: true,
			deletedDbFiles: true,
		});

		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const freshDb = dbModule.getDb();
		const accounts = await freshDb
			.selectFrom("accounts")
			.select(["id", "sync_enabled", "sync_status", "last_synced_at"])
			.orderBy("id")
			.execute();
		expect(accounts).toEqual([
			{
				id: "acct-1",
				sync_enabled: 1,
				sync_status: "idle",
				last_synced_at: null,
			},
			{
				id: "acct-2",
				sync_enabled: 0,
				sync_status: "idle",
				last_synced_at: null,
			},
		]);
		expect(
			await freshDb.selectFrom("messages").select(["id"]).execute(),
		).toEqual([]);
		expect(
			await freshDb
				.selectFrom("jobs")
				.select(["kind", "scope_type", "scope_id"])
				.execute(),
		).toEqual([
			{
				kind: "sync_account_full",
				scope_type: "account",
				scope_id: "acct-1",
			},
		]);
		expect(existsSync(join(acct1Dir, "google-oauth.json"))).toBe(true);
		expect(existsSync(join(acct2Dir, "google-oauth.json"))).toBe(true);
		expect(existsSync(acct1RawDir)).toBe(false);
		expect(existsSync(acct2RawDir)).toBe(false);
		logSpy.mockRestore();
	});

	it("fails parse-error re-extraction on old-schema databases", async () => {
		const runtime = await createTestRuntime();
		await seedLegacyPreSecondarySchema();

		const script = await runtime.importFresh<
			typeof import("#/scripts/reextract-parse-errors")
		>("#/scripts/reextract-parse-errors");

		await expect(script.main()).rejects.toMatchObject({
			name: "SchemaResetRequiredError",
		});
	});

	it("reextracts targeted parse errors, resolves leaked reviews, and queues backlog work", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const rawPath = join(rawDir, "gm-script-reextract.eml");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(
			rawPath,
			[
				"From: Billing <billing@example.com>",
				"To: acct-1@example.com",
				"Message-ID: <gm-script-reextract@example.com>",
				"Subject: Script recovery",
				"",
				"Recovered by script",
				"",
			].join("\n"),
		);

		const messageId = await insertMessageRow(db, {
			id: "msg-script-reextract",
			accountId: "acct-1",
			parseStatus: "error",
			bodyExtractionStrategy: "parse_error",
			parseErrorReason: "input.html?.trim is not a function",
			bodyTextPrimary: "",
			bodyTextNormalized: "",
			contentSha256: "old-script-content-sha",
		});
		await db
			.insertInto("message_sources")
			.values({
				id: "src-script-reextract",
				message_id: messageId,
				account_id: "acct-1",
				remote_message_id: "gm-script-reextract",
				remote_thread_id: "thr-script-reextract",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: rawPath,
				raw_sha256: "old-script-raw-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await insertMessageLabelRow(db, {
			messageId,
			lowConfidence: 1,
			contentSha256: "old-script-content-sha",
		});
		await db
			.insertInto("reviews")
			.values({
				id: "review-script-reextract",
				message_id: messageId,
				source_classification_result_id: `classification-${messageId}`,
				status: "open",
				reviewer_note: null,
				override_label_json: null,
				created_at: "2026-01-01T00:00:00.000Z",
				resolved_at: null,
			})
			.execute();

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script = await runtime.importFresh<
			typeof import("#/scripts/reextract-parse-errors")
		>("#/scripts/reextract-parse-errors");
		await script.main();

		const summary = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(summary).toEqual({
			targeted: 1,
			recovered: 1,
			stillFailing: 0,
			missingRaw: 0,
			closedReviews: 1,
			queuedAccounts: 1,
		});

		const message = await db
			.selectFrom("messages")
			.select(["parse_status", "parse_error_reason", "body_text_primary"])
			.where("id", "=", messageId)
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			parse_status: "parsed",
			parse_error_reason: null,
			body_text_primary: "Recovered by script",
		});

		const review = await db
			.selectFrom("reviews")
			.select(["status", "reviewer_note", "resolved_at"])
			.where("id", "=", "review-script-reextract")
			.executeTakeFirstOrThrow();
		expect(review).toMatchObject({
			status: "resolved",
			reviewer_note: "Superseded by parse-error re-extraction.",
		});
		expect(review.resolved_at).toBeTruthy();

		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "scope_type", "scope_id"])
			.execute();
		expect(jobs).toEqual([
			{
				kind: "classify_account_backlog",
				scope_type: "account",
				scope_id: "acct-1",
			},
		]);

		logSpy.mockRestore();
	});

	it("closes targeted parse-error reviews when reparsing still fails or raw is missing", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const rawPath = join(rawDir, "gm-script-still-failing.eml");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(rawPath, "still failing raw");

		const stillFailingMessageId = await insertMessageRow(db, {
			id: "msg-script-still-failing",
			accountId: "acct-1",
			parseStatus: "error",
			bodyExtractionStrategy: "parse_error",
			parseErrorReason: "input.html?.trim is not a function",
			bodyTextPrimary: "",
			bodyTextNormalized: "",
			contentSha256: "still-failing-content-sha",
		});
		const missingRawMessageId = await insertMessageRow(db, {
			id: "msg-script-missing-raw",
			accountId: "acct-1",
			parseStatus: "error",
			bodyExtractionStrategy: "parse_error",
			parseErrorReason: "input.html?.trim is not a function",
			bodyTextPrimary: "",
			bodyTextNormalized: "",
			contentSha256: "missing-raw-content-sha",
		});
		await db
			.insertInto("message_sources")
			.values([
				{
					id: "src-script-still-failing",
					message_id: stillFailingMessageId,
					account_id: "acct-1",
					remote_message_id: "gm-script-still-failing",
					remote_thread_id: "thr-script-still-failing",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 1,
					uidvalidity: 100,
					raw_rfc822_path: rawPath,
					raw_sha256: "still-failing-raw-sha",
					state: "active",
					first_seen_at: "2026-01-01T00:00:00.000Z",
					last_seen_at: "2026-01-01T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "src-script-missing-raw",
					message_id: missingRawMessageId,
					account_id: "acct-1",
					remote_message_id: "gm-script-missing-raw",
					remote_thread_id: "thr-script-missing-raw",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 2,
					uidvalidity: 100,
					raw_rfc822_path: join(rawDir, "missing-script.eml"),
					raw_sha256: "missing-raw-sha",
					state: "active",
					first_seen_at: "2026-01-01T00:00:00.000Z",
					last_seen_at: "2026-01-01T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-01T00:00:00.000Z",
				},
			])
			.execute();
		await insertMessageLabelRow(db, {
			messageId: stillFailingMessageId,
			lowConfidence: 1,
			contentSha256: "still-failing-content-sha",
		});
		await insertMessageLabelRow(db, {
			messageId: missingRawMessageId,
			lowConfidence: 1,
			contentSha256: "missing-raw-content-sha",
		});
		await db
			.insertInto("reviews")
			.values([
				{
					id: "review-script-still-failing",
					message_id: stillFailingMessageId,
					source_classification_result_id: `classification-${stillFailingMessageId}`,
					status: "open",
					reviewer_note: null,
					override_label_json: null,
					created_at: "2026-01-01T00:00:00.000Z",
					resolved_at: null,
				},
				{
					id: "review-script-missing-raw",
					message_id: missingRawMessageId,
					source_classification_result_id: `classification-${missingRawMessageId}`,
					status: "open",
					reviewer_note: null,
					override_label_json: null,
					created_at: "2026-01-01T00:00:00.000Z",
					resolved_at: null,
				},
			])
			.execute();

		vi.doMock("#/lib/imap", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/imap")>("#/lib/imap");
			return {
				...actual,
				parseRawMessage: vi.fn(async () => ({
					id: "msg-script-still-failing-new",
					messageId: "<msg-script-still-failing-new@example.com>",
					threadKey: "thread-script-still-failing-new",
					receivedAt: "2026-01-01T00:00:00.000Z",
					senderName: null,
					senderAddress: null,
					toJson: "[]",
					ccJson: "[]",
					subject: null,
					inReplyTo: null,
					bodyTextPrimary: "",
					bodyTextForwarded: "",
					bodyTextNormalized: "",
					snippet: "",
					attachmentCount: 0,
					hasHtml: 0,
					parseStatus: "error",
					bodyExtractionStrategy: "parse_error",
					parseErrorReason: "still failing",
					tokenEstimate: 0,
					contentSha256: "still-failing-new-content-sha",
					attachments: [],
				})),
			};
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script = await runtime.importFresh<
			typeof import("#/scripts/reextract-parse-errors")
		>("#/scripts/reextract-parse-errors");
		await script.main();

		const summary = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(summary).toEqual({
			targeted: 2,
			recovered: 0,
			stillFailing: 1,
			missingRaw: 1,
			closedReviews: 2,
			queuedAccounts: 0,
		});

		const reviews = await db
			.selectFrom("reviews")
			.select(["id", "status", "reviewer_note", "resolved_at"])
			.orderBy("id")
			.execute();
		expect(reviews).toEqual([
			expect.objectContaining({
				id: "review-script-missing-raw",
				status: "resolved",
				reviewer_note:
					"Closed by parse-error recovery; parser failures are audited outside review.",
			}),
			expect.objectContaining({
				id: "review-script-still-failing",
				status: "resolved",
				reviewer_note:
					"Closed by parse-error recovery; parser failures are audited outside review.",
			}),
		]);
		expect(reviews.every((review) => Boolean(review.resolved_at))).toBe(true);
		expect(await db.selectFrom("jobs").select(["id"]).execute()).toEqual([]);

		logSpy.mockRestore();
	});

	it("repairs bad parsed bodies and queues root reclassification", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const rawPath = join(rawDir, "gm-script-bad-body.eml");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(rawPath, "bad body raw");

		const messageId = await insertMessageRow(db, {
			id: "msg-script-bad-body",
			accountId: "acct-1",
			parseStatus: "parsed",
			bodyExtractionStrategy: "plain_text",
			parseErrorReason: null,
			bodyTextPrimary: "Plain text version not available",
			bodyTextNormalized: "Plain text version not available",
			snippet: "undefined",
			contentSha256: "bad-body-content-sha",
			ingestedAt: "2026-01-02T00:00:00.000Z",
		});
		await db
			.insertInto("message_sources")
			.values({
				id: "src-script-bad-body",
				message_id: messageId,
				account_id: "acct-1",
				remote_message_id: "gm-script-bad-body",
				remote_thread_id: "thr-script-bad-body",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: rawPath,
				raw_sha256: "bad-body-raw-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		const before = await db
			.selectFrom("messages")
			.select(["created_at", "ingested_at"])
			.where("id", "=", messageId)
			.executeTakeFirstOrThrow();

		vi.doMock("#/lib/imap", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/imap")>("#/lib/imap");
			return {
				...actual,
				parseRawMessage: vi.fn(async () => ({
					id: "msg-script-bad-body-new",
					messageId: "<msg-script-bad-body-new@example.com>",
					threadKey: "thread-script-bad-body",
					receivedAt: "2026-01-01T00:00:00.000Z",
					senderName: null,
					senderAddress: null,
					toJson: "[]",
					ccJson: "[]",
					subject: "Recovered",
					inReplyTo: null,
					bodyTextPrimary: "Recovered body text",
					bodyTextForwarded: "",
					bodyTextNormalized: "Recovered body text",
					snippet: "Recovered body text",
					attachmentCount: 0,
					hasHtml: 1,
					parseStatus: "parsed",
					bodyExtractionStrategy: "html_to_text",
					parseErrorReason: null,
					tokenEstimate: 12,
					contentSha256: "recovered-bad-body-sha",
					attachments: [],
				})),
			};
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script = await runtime.importFresh<
			typeof import("#/scripts/reextract-bad-bodies")
		>("#/scripts/reextract-bad-bodies");
		await script.main();

		const summary = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(summary).toEqual({
			targeted: 1,
			recovered: 1,
			stillFailing: 0,
			missingRaw: 0,
			queuedAccounts: 1,
		});

		const message = await db
			.selectFrom("messages")
			.select([
				"body_text_primary",
				"body_text_normalized",
				"snippet",
				"body_extraction_strategy",
				"content_sha256",
				"created_at",
				"ingested_at",
			])
			.where("id", "=", messageId)
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			body_text_primary: "Recovered body text",
			body_text_normalized: "Recovered body text",
			snippet: "Recovered body text",
			body_extraction_strategy: "html_to_text",
			content_sha256: "recovered-bad-body-sha",
			created_at: before.created_at,
			ingested_at: before.ingested_at,
		});

		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "scope_type", "scope_id"])
			.execute();
		expect(jobs).toEqual([
			{
				kind: "classify_account_backlog",
				scope_type: "account",
				scope_id: "acct-1",
			},
		]);

		logSpy.mockRestore();
	});

	it("drains the worker script", async () => {
		const runtime = await createTestRuntime();
		const { bootDb } = await import("#/test/helpers/db");
		const { dbModule } = await bootDb({ seedDefaultAccount: true });
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		await jobs.queueJob({
			kind: "rebuild_overseer",
			scopeType: "account",
			scopeId: "acct-1",
		});

		vi.doMock("#/lib/pi", () => ({
			piJson: vi.fn(async () => ({
				backend: "openai-api",
				modelId: "gpt-5-mini",
				parsed: {
					schemaVersion: "overseer-profile.v1",
					accountId: "acct-1",
					builtFromMessages: 0,
					knownBusinessDomains: [],
					knownPersonalDomains: [],
					knownFinancialSenders: [],
					recurringPurposeHints: [],
					confidentialityPatterns: [],
					promotedTags: [],
					promptPreamble: "none",
				},
				rawText: "{}",
				usage: null,
			})),
		}));

		const script = await runtime.importFresh<
			typeof import("#/scripts/worker-drain")
		>("#/scripts/worker-drain");
		await script.main();

		const rows = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["status"])
			.execute();
		expect(rows[0]?.status).toBe("complete");
	});

	it("prints a corpus audit report", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const script = await runtime.importFresh<
			typeof import("#/scripts/audit-corpus")
		>("#/scripts/audit-corpus");
		await script.main(undefined, [
			"node",
			"scripts/audit-corpus.ts",
			"--org",
			"local",
		]);

		expect(logSpy).toHaveBeenCalledTimes(1);
		const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(report).toMatchObject({
			runtime: expect.objectContaining({
				orgId: "local",
			}),
			auth: expect.any(Object),
			financeImportDedup: expect.any(Object),
			sourceInvariants: expect.any(Object),
			rootClassification: expect.any(Object),
			moderation: expect.any(Object),
			parseErrors: expect.any(Object),
			conversations: expect.any(Object),
			secondaryFinance: expect.any(Object),
			registry: expect.any(Object),
		});

		logSpy.mockRestore();
	});

	it("scopes corpus audit to the requested org", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		dbModule.runMigrations("org-a");
		dbModule.runMigrations("org-b");
		const dbA = dbModule.getDb("org-a");
		const dbB = dbModule.getDb("org-b");
		await seedTestAccount(dbA, { id: "acct-a", emailAddress: "a@example.com" });
		await seedTestAccount(dbB, { id: "acct-b", emailAddress: "b@example.com" });
		await insertMessageRow(dbA, {
			id: "msg-org-a",
			accountId: "acct-a",
			contentSha256: "sha-org-a",
		});
		await insertMessageRow(dbB, {
			id: "msg-org-b",
			accountId: "acct-b",
			contentSha256: "sha-org-b",
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script = await runtime.importFresh<
			typeof import("#/scripts/audit-corpus")
		>("#/scripts/audit-corpus");
		await script.main(undefined, [
			"node",
			"scripts/audit-corpus.ts",
			"--org",
			"org-a",
		]);

		const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(report.runtime.orgId).toBe("org-a");
		expect(report.sourceInvariants.messages).toBe(1);
		logSpy.mockRestore();
	});

	it("imports finance artifacts into the selected org only", async () => {
		const runtime = await createTestRuntime();
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		dbModule.runMigrations("org-a");
		dbModule.runMigrations("org-b");
		const artifactPath = join(runtime.root, "artifact.json");
		writeFileSync(
			artifactPath,
			JSON.stringify(buildFinanceArtifact("artifact-sha-script"), null, 2),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script = await runtime.importFresh<
			typeof import("#/scripts/import-finance-artifact")
		>("#/scripts/import-finance-artifact");
		await script.main(undefined, [
			"node",
			"scripts/import-finance-artifact.ts",
			"--org",
			"org-a",
			artifactPath,
		]);
		await script.main(undefined, [
			"node",
			"scripts/import-finance-artifact.ts",
			"--org",
			"org-a",
			artifactPath,
		]);

		const summary = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		const duplicateSummary = JSON.parse(
			String(logSpy.mock.calls[1]?.[0] ?? "{}"),
		);
		expect(summary).toMatchObject({
			ok: true,
			orgId: "org-a",
			imported: expect.objectContaining({
				status: "imported",
				artifactSha256: "artifact-sha-script",
			}),
		});
		expect(duplicateSummary).toMatchObject({
			ok: true,
			orgId: "org-a",
			imported: expect.objectContaining({
				status: "already_imported",
				importRunId: summary.imported.importRunId,
				artifactSha256: "artifact-sha-script",
			}),
		});
		expect(
			dbModule
				.getSqlite("org-a")
				.prepare("SELECT COUNT(*) AS count FROM finance_import_runs")
				.get(),
		).toEqual({ count: 1 });
		expect(
			dbModule
				.getSqlite("org-b")
				.prepare("SELECT COUNT(*) AS count FROM finance_import_runs")
				.get(),
		).toEqual({ count: 0 });
		logSpy.mockRestore();
	});

	it("prints populated corpus audit details", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const { db } = await bootDb({ seedDefaultAccount: true });
		const conversationId = await insertConversationRow(db, {
			id: "conv-audit-script",
			accountId: "acct-1",
			gmailThreadId: "thr-audit-script",
			firstMessageReceivedAt: "2026-01-01T00:00:00.000Z",
			lastMessageReceivedAt: "2026-01-12T00:00:00.000Z",
			messageCount: 2,
		});
		const lastMismatchConversationId = await insertConversationRow(db, {
			id: "conv-audit-script-last-mismatch",
			accountId: "acct-1",
			gmailThreadId: "thr-audit-script-last-mismatch",
			firstMessageReceivedAt: null,
			lastMessageReceivedAt: null,
			messageCount: 1,
		});
		await insertConversationRow(db, {
			id: "conv-audit-script-orphan",
			accountId: "acct-1",
			gmailThreadId: "thr-audit-script-orphan",
			firstMessageReceivedAt: null,
			lastMessageReceivedAt: null,
			messageCount: 1,
		});
		const messageId = await insertMessageRow(db, {
			id: "msg-audit-script",
			accountId: "acct-1",
			conversationId,
			receivedAt: "2026-01-10T00:00:00.000Z",
			parseStatus: "error",
			parseErrorReason: "input.html?.trim is not a function",
			contentSha256: "content-audit-script",
		});
		const laterMessageId = await insertMessageRow(db, {
			id: "msg-audit-script-later",
			accountId: "acct-1",
			conversationId,
			receivedAt: "2026-01-12T00:00:00.000Z",
			parseStatus: "parsed",
			contentSha256: "content-audit-script-later",
		});
		const lastMismatchMessageId = await insertMessageRow(db, {
			id: "msg-audit-script-last-mismatch",
			accountId: "acct-1",
			conversationId: lastMismatchConversationId,
			receivedAt: "2026-01-11T00:00:00.000Z",
			parseStatus: "parsed",
			contentSha256: "content-audit-script-last-mismatch",
		});
		await insertMessageRow(db, {
			id: "msg-audit-script-no-reason",
			accountId: "acct-1",
			conversationId: null,
			receivedAt: "2026-01-13T00:00:00.000Z",
			parseStatus: "error",
			parseErrorReason: null,
			contentSha256: "content-audit-script-no-reason",
		});
		await db
			.insertInto("message_sources")
			.values([
				{
					id: "source-audit-script",
					message_id: messageId,
					account_id: "acct-1",
					remote_message_id: "gm-audit-script",
					remote_thread_id: "thr-audit-script",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 1,
					uidvalidity: 1,
					raw_rfc822_path: "/tmp/audit.eml",
					raw_sha256: "raw-audit-script",
					state: "active",
					first_seen_at: "2026-01-10T00:00:00.000Z",
					last_seen_at: "2026-01-10T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "source-audit-script-later",
					message_id: laterMessageId,
					account_id: "acct-1",
					remote_message_id: "gm-audit-script-later",
					remote_thread_id: "thr-audit-script",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 2,
					uidvalidity: 1,
					raw_rfc822_path: "/tmp/audit-later.eml",
					raw_sha256: "raw-audit-script-later",
					state: "active",
					first_seen_at: "2026-01-12T00:00:00.000Z",
					last_seen_at: "2026-01-12T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-12T00:00:00.000Z",
				},
				{
					id: "source-audit-script-last-mismatch",
					message_id: lastMismatchMessageId,
					account_id: "acct-1",
					remote_message_id: "gm-audit-script-last-mismatch",
					remote_thread_id: "thr-audit-script-last-mismatch",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 3,
					uidvalidity: 1,
					raw_rfc822_path: "/tmp/audit-last-mismatch.eml",
					raw_sha256: "raw-audit-script-last-mismatch",
					state: "active",
					first_seen_at: "2026-01-11T00:00:00.000Z",
					last_seen_at: "2026-01-11T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-11T00:00:00.000Z",
				},
			])
			.execute();
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "stale-audit-label",
			label: {
				schemaVersion: "message-label.v1",
				nsfw: false,
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "amex",
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
					overall: 0.95,
					finance: 0.95,
					social: 0.95,
					risk: 0.95,
				},
				explanation: "finance",
			},
		});
		await insertSecondaryResultRow(db, {
			messageId,
			status: "blocked_parse_error",
			contentSha256: "content-audit-script",
			registrySha256: "registry-audit-script",
		});
		await db
			.insertInto("reviews")
			.values({
				id: "review-audit-script",
				message_id: messageId,
				source_classification_result_id: "classification-msg-audit-script",
				status: "open",
				reviewer_note: null,
				override_label_json: null,
				resolved_at: null,
				created_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("registry_import_state")
			.values({
				key: "operator_registry",
				combined_sha256: "registry-audit-script",
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
		await db
			.insertInto("moderation_results")
			.values([
				{
					id: "moderation-audit-current",
					job_id: null,
					message_id: messageId,
					model: "gpt-5.4-mini",
					categories_json: "{}",
					category_scores_json: "{}",
					raw_response_json: JSON.stringify({
						promptVersion: config.MODERATION_PROMPT_VERSION,
					}),
					nsfw_flag: 0,
					created_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "moderation-audit-stale",
					job_id: null,
					message_id: laterMessageId,
					model: "gpt-5.4-mini",
					categories_json: "{}",
					category_scores_json: "{}",
					raw_response_json: JSON.stringify({
						promptVersion: "moderate-email-v1",
					}),
					nsfw_flag: 0,
					created_at: "2026-01-12T00:00:00.000Z",
				},
				{
					id: "moderation-audit-missing",
					job_id: null,
					message_id: lastMismatchMessageId,
					model: "gpt-5.4-mini",
					categories_json: "{}",
					category_scores_json: "{}",
					raw_response_json: JSON.stringify({
						rawResponse: { assistantText: "{}" },
					}),
					nsfw_flag: 0,
					created_at: "2026-01-11T00:00:00.000Z",
				},
			])
			.execute();

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const script = await runtime.importFresh<
			typeof import("#/scripts/audit-corpus")
		>("#/scripts/audit-corpus");
		await script.main(undefined, [
			"node",
			"scripts/audit-corpus.ts",
			"--org",
			"local",
		]);

		const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
		expect(report.rootClassification.staleLabels).toBe(1);
		expect(report.parseErrors.total).toBe(2);
		expect(report.parseErrors.openReviewLeakage).toBe(1);
		expect(report.parseErrors.reasons).toEqual(
			expect.arrayContaining([
				{
					reason: "input.html?.trim is not a function",
					count: 1,
				},
				{
					reason: "(none)",
					count: 1,
				},
			]),
		);
		expect(report.moderation).toEqual({
			currentPromptVersion: config.MODERATION_PROMPT_VERSION,
			rowsWithCurrentPromptVersion: 1,
			rowsWithStalePromptVersion: 1,
			rowsMissingPromptVersion: 1,
		});
		expect(report.secondaryFinance).toMatchObject({
			rootFinanceRelevantMessages: 1,
			totalHeads: 1,
			statuses: {
				blocked_parse_error: 1,
			},
		});
		expect(report.conversations).toMatchObject({
			nullConversationLinks: 1,
			rollupMismatches: 3,
		});
		expect(report.registry).toEqual({
			importedAt: "2026-01-10T00:00:00.000Z",
			sourceDir: "/tmp/registry",
			sha256: "registry-audit-script",
			counts: {
				identities: 1,
				institutions: 0,
				financialAccounts: 0,
				senderRules: 0,
			},
		});

		logSpy.mockRestore();
	});
});
