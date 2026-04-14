import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { bootDb, seedTestAccount } from "#/test/helpers/db";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("new server actions", () => {
	it("loadAccountsData returns an empty array on a fresh database", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.loadAccountsData();

		expect(result.accounts).toEqual([]);
	});

	it("loadAccountsData includes message and tombstone counts from seeded data", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		const { insertMessageRow } = await import("#/test/helpers/db");
		await seedTestAccount(db);

		const messageId = await insertMessageRow(db);
		await db
			.insertInto("message_sources")
			.values({
				id: "source-1",
				message_id: messageId,
				account_id: "acct-1",
				remote_message_id: null,
				remote_thread_id: null,
				mailbox: null,
				imap_uid: null,
				uidvalidity: null,
				raw_rfc822_path: null,
				raw_sha256: null,
				state: "tombstoned",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: "2026-01-02T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.loadAccountsData();
		const account = result.accounts.find((a) => a.id === "acct-1");

		expect(account).toBeTruthy();
		expect(account?.label).toBe("Test Account");
		expect(account?.message_count).toBe(1);
		expect(account?.tombstone_count).toBe(1);
	});

	it("loadAccountNewData returns oauth readiness (false without env vars)", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.loadAccountNewData();

		expect(result.oauthReady).toBe(false);
		expect(result.missingVars).toBeInstanceOf(Array);
		expect(result.missingVars.length).toBeGreaterThan(0);
		expect(result.redirectUrl).toBe(
			"http://127.0.0.1:3000/oauth/google/callback",
		);
	});

	it("loadAccountNewData returns readiness and redirectUrl from env", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
		process.env.GOOGLE_OAUTH_REDIRECT_URL =
			"http://localhost:3000/oauth/google/callback";
		vi.resetModules();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.loadAccountNewData();

		expect(result.oauthReady).toBe(true);
		expect(result.missingVars).toEqual([]);
		expect(result.redirectUrl).toBe(
			"http://localhost:3000/oauth/google/callback",
		);
	});

	it("loadAccountDetailData returns account, null syncState, empty jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.loadAccountDetailData({
			accountId: "acct-1",
		});

		expect(result.account).toBeTruthy();
		expect(result.account.id).toBe("acct-1");
		expect(result.account.label).toBe("Test Account");
		expect(result.syncState).toBeNull();
		expect(result.recentJobs).toEqual([]);
		expect(result.messageCount).toBe(0);
		expect(result.tombstoneCount).toBe(0);
	});

	it("loadAccountDetailData throws for unknown account", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await expect(
			actions.loadAccountDetailData({ accountId: "nonexistent" }),
		).rejects.toThrow();
	});

	it("completeGoogleConnectCommand creates a new account, token file, sync state, and full sync job", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Personal Gmail",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "User@Example.com"),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		const db = dbModule.getDb();
		const account = await db
			.selectFrom("accounts")
			.selectAll()
			.where("id", "=", result.accountId)
			.executeTakeFirstOrThrow();
		const syncState = await db
			.selectFrom("account_sync_state")
			.selectAll()
			.where("account_id", "=", result.accountId)
			.executeTakeFirstOrThrow();
		const job = await db
			.selectFrom("jobs")
			.selectAll()
			.where("scope_id", "=", result.accountId)
			.where("kind", "=", "sync_account_full")
			.executeTakeFirstOrThrow();

		expect(account.email_address).toBe("user@example.com");
		expect(account.label).toBe("Personal Gmail");
		expect(account.sync_enabled).toBe(1);
		expect(syncState.account_id).toBe(result.accountId);
		expect(job.scope_id).toBe(result.accountId);
		expect(job.kind).toBe("sync_account_full");

		const oauthPath = config.accountOAuthPath(result.accountId);
		expect(existsSync(oauthPath)).toBe(true);
		expect(JSON.parse(readFileSync(oauthPath, "utf8"))).toMatchObject({
			emailAddress: "user@example.com",
			accessToken: "access-token",
		});
	});

	it("completeGoogleConnectCommand reconnects by reusing an existing account row case-insensitively", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing",
			label: "Old Label",
			emailAddress: "user@example.com",
			syncEnabled: 0,
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Renamed Gmail",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "USER@example.com"),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		const rows = await db.selectFrom("accounts").selectAll().execute();
		const account = rows.find((row) => row.id === "acct-existing");

		expect(result.accountId).toBe("acct-existing");
		expect(rows).toHaveLength(1);
		expect(account).toMatchObject({
			label: "Renamed Gmail",
			email_address: "user@example.com",
			sync_enabled: 1,
		});
	});

	it("completeGoogleConnectCommand throws for invalid or expired OAuth state", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => null),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");

		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "missing-state",
			}),
		).rejects.toThrow("Invalid or expired OAuth state");
	});

	it("completeGoogleConnectCommand surfaces token exchange failures", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Broken Gmail",
				})),
				exchangeCode: vi.fn(async () => {
					throw new Error("Token exchange failed: 400 bad request");
				}),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");

		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "oauth-state",
			}),
		).rejects.toThrow("Token exchange failed: 400 bad request");
	});

	it("completeGoogleConnectCommand tolerates duplicate active full-sync jobs", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Personal Gmail",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "user@example.com"),
			};
		});
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJob: vi.fn(async () => {
					throw new Error("SQLITE_CONSTRAINT: jobs_open_scope_idx");
				}),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		expect(result.accountId).toBeTruthy();
	});

	it("beginGoogleConnectCommand returns the Google auth URL payload", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl: vi.fn((label: string) => ({
					url: `https://accounts.google.com/?label=${encodeURIComponent(label)}`,
					state: "oauth-state",
				})),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		const result = await actions.beginGoogleConnectCommand({
			label: "Personal Gmail",
		});

		expect(result).toEqual({
			url: "https://accounts.google.com/?label=Personal%20Gmail",
			state: "oauth-state",
		});
	});

	it("queues account jobs idempotently with the expected kinds and metadata", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
			syncStatus: "idle",
		});

		const queueJobIdempotent = vi.fn(async () => "job-1");
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await actions.queueAccountFullSyncCommand({ accountId: "acct-1" });
		await actions.queueAccountDeltaSyncCommand({ accountId: "acct-1" });
		await actions.queueAccountReconcileCommand({ accountId: "acct-1" });
		await actions.queueAccountClassifyBacklogCommand({ accountId: "acct-1" });

		expect(queueJobIdempotent).toHaveBeenNthCalledWith(1, {
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenNthCalledWith(2, {
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenNthCalledWith(3, {
			kind: "sync_account_reconcile",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenNthCalledWith(4, {
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v1",
		});
	});

	it("rejects paused remote sync commands while still allowing backlog classification", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-paused",
			syncEnabled: 0,
			syncStatus: "paused",
		});

		const queueJobIdempotent = vi.fn(async () => "job-local");
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");

		await expect(
			actions.queueAccountFullSyncCommand({ accountId: "acct-paused" }),
		).rejects.toThrow(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);
		await expect(
			actions.queueAccountDeltaSyncCommand({ accountId: "acct-paused" }),
		).rejects.toThrow(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);
		await expect(
			actions.queueAccountReconcileCommand({ accountId: "acct-paused" }),
		).rejects.toThrow(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);

		await expect(
			actions.queueAccountClassifyBacklogCommand({ accountId: "acct-paused" }),
		).resolves.toBe("job-local");
		expect(queueJobIdempotent).toHaveBeenCalledTimes(1);
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-paused",
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v1",
		});
	});

	it("queues overseer rebuilds without dead force metadata", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const queueJob = vi.fn(async () => "job-overseer");
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJob,
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await actions.enqueueOverseerCommand({ accountId: "acct-1" });

		expect(queueJob).toHaveBeenCalledWith({
			kind: "rebuild_overseer",
			scopeType: "account",
			scopeId: "acct-1",
			model: "gpt-5-mini",
			promptVersion: "overseer-profile-v1",
		});
	});

	it("pauses, resumes, and disconnects account sync", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		await db
			.insertInto("account_sync_state")
			.values({
				account_id: "acct-1",
				uidvalidity: 100,
				latest_uid_cursor: 42,
				earliest_uid_cursor: 1,
				backfill_snapshot_uid: 42,
				backfill_next_uid: null,
				last_bootstrap_started_at: "2026-01-01T00:00:00.000Z",
				last_bootstrap_completed_at: "2026-01-01T00:05:00.000Z",
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: "2026-01-01T00:05:00.000Z",
				backfill_completed_at: "2026-01-01T00:05:00.000Z",
				last_idle_started_at: null,
				last_idle_heartbeat_at: null,
				watcher_status: "stopped",
				consecutive_failures: 0,
				backoff_until: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const stopWatcher = vi.fn(async () => undefined);
		const startWatcher = vi.fn(async () => undefined);
		const deleteOAuthToken = vi.fn(() => undefined);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			stopWatcher,
			startWatcher,
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				deleteOAuthToken,
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");

		await expect(
			actions.pauseAccountSyncCommand({ accountId: "acct-1" }),
		).resolves.toEqual({ status: "paused" });
		let account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status"])
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 0,
			sync_status: "paused",
		});
		expect(stopWatcher).toHaveBeenCalledWith("acct-1");

		await expect(
			actions.resumeAccountSyncCommand({ accountId: "acct-1" }),
		).resolves.toEqual({ status: "resumed" });
		account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status"])
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 1,
			sync_status: "idle",
		});
		expect(startWatcher).toHaveBeenCalledWith("acct-1");

		await expect(
			actions.disconnectAccountCommand({ accountId: "acct-1" }),
		).resolves.toEqual({ status: "disconnected" });
		account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status", "last_error"])
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 0,
			sync_status: "idle",
			last_error: null,
		});
		expect(stopWatcher).toHaveBeenCalledTimes(2);
		expect(deleteOAuthToken).toHaveBeenCalledWith("acct-1");
	});

	it("resume restores backfilling state and requeues pending historical work", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await db
			.insertInto("account_sync_state")
			.values({
				account_id: "acct-backfill",
				uidvalidity: 100,
				latest_uid_cursor: 42,
				earliest_uid_cursor: 21,
				backfill_snapshot_uid: 42,
				backfill_next_uid: 20,
				last_bootstrap_started_at: "2026-01-01T00:00:00.000Z",
				last_bootstrap_completed_at: "2026-01-01T00:05:00.000Z",
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: "2026-01-01T00:05:00.000Z",
				backfill_completed_at: null,
				last_idle_started_at: null,
				last_idle_heartbeat_at: null,
				watcher_status: "stopped",
				consecutive_failures: 0,
				backoff_until: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const queueJobIdempotent = vi.fn(async () => "job-backfill");
		const startWatcher = vi.fn(async () => undefined);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			startWatcher,
			stopWatcher: vi.fn(async () => undefined),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");

		await expect(
			actions.resumeAccountSyncCommand({ accountId: "acct-backfill" }),
		).resolves.toEqual({ status: "resumed" });

		const account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status"])
			.where("id", "=", "acct-backfill")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 1,
			sync_status: "backfilling",
		});
		expect(startWatcher).toHaveBeenCalledWith("acct-backfill");
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "acct-backfill",
		});
	});

	it("emits loader log events for account views", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);

		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await actions.loadAccountsData();
		await actions.loadAccountNewData();
		await actions.loadAccountDetailData({ accountId: "acct-1" });

		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "loader",
			operation: "loadAccountsData",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "loader",
			operation: "loadAccountNewData",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "loader",
			operation: "loadAccountDetailData",
			account_id: "acct-1",
		});
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "server.action.start",
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						accounts: 1,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						oauth_ready: false,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						message_count: 0,
						tombstone_count: 0,
						recent_jobs: 0,
						has_sync_state: false,
					}),
				}),
			]),
		);
	});

	it("logs unavailable runtime backend summaries for runs data", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				listJobs: vi.fn(async () => []),
			};
		});
		vi.doMock("#/lib/pi", () => ({
			getPiStatus: vi.fn(async () => ({
				subscriptionConfigured: false,
				apiConfigured: false,
				preferredBackend: "auto",
				resolvedBackend: null,
			})),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await actions.loadRunsData();

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						jobs: 0,
						resolved_backend: "unavailable",
					}),
				}),
			]),
		);
	});

	it("emits connect and queue command log events", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const log = createMockLogModule();
		let queueIndex = 0;
		const queueJobIdempotent = vi.fn(
			async (input: { kind: string }) => `job-${input.kind}-${++queueIndex}`,
		);
		const queueJob = vi.fn(async () => "job-overseer-1");

		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl: vi.fn((label: string) => ({
					url: `https://accounts.google.com/?label=${encodeURIComponent(label)}`,
					state: "oauth-state",
				})),
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Personal Gmail",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "user@example.com"),
			};
		});
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJob,
				queueJobIdempotent,
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await actions.beginGoogleConnectCommand({
			label: "Personal Gmail",
		});
		const { accountId } = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});
		await actions.queueAccountFullSyncCommand({ accountId });
		await actions.queueAccountDeltaSyncCommand({ accountId });
		await actions.queueAccountReconcileCommand({ accountId });
		await actions.queueAccountClassifyBacklogCommand({ accountId });
		await actions.enqueueOverseerCommand({ accountId });

		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "beginGoogleConnectCommand",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "completeGoogleConnectCommand",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "queueAccountFullSyncCommand",
			account_id: accountId,
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "enqueueOverseerCommand",
			account_id: accountId,
		});
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						oauth_redirect_prepared: true,
					}),
				}),
				expect.objectContaining({
					type: "add",
					fields: expect.objectContaining({
						account_id: accountId,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						account_id: accountId,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-sync_account_full-2",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-sync_account_delta-3",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-sync_account_reconcile-4",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-classify_account_backlog-5",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-overseer-1",
					}),
				}),
			]),
		);
	});

	it("emits review, classify, and sync toggle command log events", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		const { insertMessageRow } = await import("#/test/helpers/db");
		const messageId = await insertMessageRow(db, {
			id: "message-1",
			accountId: "acct-1",
		});

		await db
			.insertInto("classification_results")
			.values({
				id: "classification-1",
				job_id: null,
				message_id: messageId,
				model: "gpt-5.4-mini",
				prompt_version: "classify-email-v1",
				source: "model",
				result_json: "{}",
				raw_response_json: "{}",
				usage_json: null,
				low_confidence: 1,
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("reviews")
			.values({
				id: "review-1",
				message_id: messageId,
				source_classification_result_id: "classification-1",
				status: "open",
				reviewer_note: null,
				override_label_json: null,
				created_at: "2026-01-01T00:00:00.000Z",
				resolved_at: null,
			})
			.execute();

		const log = createMockLogModule();
		const stopWatcher = vi.fn(async () => undefined);
		const startWatcher = vi.fn(async () => undefined);
		const deleteOAuthToken = vi.fn(() => undefined);
		const ensureModerationForMessage = vi.fn(async () => ({
			nsfwFlag: false,
			scores: {
				sexual: 0,
			},
		}));
		const classifyMessageNow = vi.fn(async () => undefined);

		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			startWatcher,
			stopWatcher,
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				deleteOAuthToken,
			};
		});
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage,
			topModerationScores: vi.fn(() => ({ sexual: 0 })),
		}));
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(() => "none"),
			classifyMessageNow,
			mergeAllowedTags: vi.fn(() => []),
			writeManualOverride: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			loadLatestOverseerContext: vi.fn(async () => ({
				promptPreamble: "Known sender.",
				promotedTags: ["receipt"],
			})),
		}));

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await actions.resolveReviewCommand({
			reviewId: "review-1",
			action: "accept",
		});
		await actions.classifyOneNowCommand({ messageId });
		await actions.pauseAccountSyncCommand({ accountId: "acct-1" });
		await actions.resumeAccountSyncCommand({ accountId: "acct-1" });
		await actions.disconnectAccountCommand({ accountId: "acct-1" });

		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "resolveReviewCommand",
			review_id: "review-1",
			review_action: "accept",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "classifyOneNowCommand",
			message_id: messageId,
		});
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "add",
					fields: expect.objectContaining({
						message_id: messageId,
					}),
				}),
				expect.objectContaining({
					type: "add",
					fields: expect.objectContaining({
						account_id: "acct-1",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "accepted",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "classified",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "paused",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "resumed",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "disconnected",
					}),
				}),
			]),
		);
	});

	it("emits failure log events for action errors", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => null),
			};
		});

		const actions = await runtime.importFresh<
			typeof import("#/app/server/actions")
		>("#/app/server/actions");
		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "missing-state",
			}),
		).rejects.toThrow("Invalid or expired OAuth state");

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "server.action.start",
				}),
				expect.objectContaining({
					type: "fail",
					event: "server.action.fail",
				}),
			]),
		);
	});
});
