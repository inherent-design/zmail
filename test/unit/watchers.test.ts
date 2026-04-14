import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootDb, seedTestAccount } from "#/test/helpers/db";
import { setEnv } from "#/test/helpers/env";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

async function insertSyncState(accountId: string) {
	const { getDb } = await import("#/lib/db");
	const db = getDb();
	await db
		.insertInto("account_sync_state")
		.values({
			account_id: accountId,
			uidvalidity: null,
			latest_uid_cursor: null,
			earliest_uid_cursor: null,
			backfill_snapshot_uid: null,
			backfill_next_uid: null,
			last_bootstrap_started_at: null,
			last_bootstrap_completed_at: null,
			last_delta_sync_at: null,
			last_reconcile_at: null,
			last_backfill_sync_at: null,
			backfill_completed_at: null,
			last_idle_started_at: null,
			last_idle_heartbeat_at: null,
			watcher_status: "stopped",
			consecutive_failures: 2,
			backoff_until: "2026-01-01T00:00:00.000Z",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		})
		.execute();
}

function createMockClient() {
	const handlers = new Map<string, () => void>();
	const lock = {
		release: vi.fn(),
	};
	const client = {
		connect: vi.fn(async () => undefined),
		getMailboxLock: vi.fn(async () => lock),
		logout: vi.fn(async () => undefined),
		on: vi.fn((event: string, handler: () => void) => {
			handlers.set(event, handler);
			return client;
		}),
		emit(event: string) {
			handlers.get(event)?.();
		},
		lock,
	};

	return client;
}

describe("watchers", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		try {
			const watchers = await import("#/lib/watchers");
			await watchers.stopAllWatchers();
		} catch {
			// ignore cleanup errors from failed imports
		}
		vi.useRealTimers();
	});

	it("starts one watcher, enqueues delta and reconcile work, and stops cleanly", async () => {
		const runtime = await createTestRuntime();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		setEnv({
			ZMAIL_IMAP_POLL_MS: "10",
			ZMAIL_IMAP_MAX_IDLE_MS: "20",
			ZMAIL_SYNC_RECONCILE_MS: "30",
		});
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
		});
		await insertSyncState("acct-1");

		const queueJobIdempotent = vi.fn(async () => "job-1");
		const client = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		const rootTrace = log.module.startTrace({
			kind: "test",
			operation: "watcher-root",
		});

		await watchers.startWatcher("acct-1", rootTrace);
		await watchers.startWatcher("acct-1");

		expect(watchers.getWatcherStatus("acct-1")).toBe("running");
		expect(watchers.getActiveWatcherCount()).toBe(1);
		expect(client.connect).toHaveBeenCalledTimes(1);

		client.emit("exists");
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(35);

		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_reconcile",
			scopeType: "account",
			scopeId: "acct-1",
		});

		const syncState = await db
			.selectFrom("account_sync_state")
			.select([
				"watcher_status",
				"last_idle_started_at",
				"last_idle_heartbeat_at",
				"consecutive_failures",
				"backoff_until",
			])
			.where("account_id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(syncState.watcher_status).toBe("idle");
		expect(syncState.last_idle_started_at).toBeTruthy();
		expect(syncState.last_idle_heartbeat_at).toBeTruthy();
		expect(syncState.consecutive_failures).toBe(0);
		expect(syncState.backoff_until).toBeNull();

		await watchers.stopWatcher("acct-1");
		await watchers.stopAllWatchers();

		expect(client.lock.release).toHaveBeenCalled();
		expect(client.logout).toHaveBeenCalled();
		expect(watchers.getWatcherStatus("acct-1")).toBe("stopped");
		expect(watchers.getActiveWatcherCount()).toBe(0);
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "watcher.start",
				}),
				expect.objectContaining({
					type: "complete",
					event: "watcher.connected",
				}),
				expect.objectContaining({
					type: "complete",
					event: "watcher.exists_enqueued",
				}),
				expect.objectContaining({
					type: "complete",
					event: "watcher.poll_enqueued",
				}),
				expect.objectContaining({
					type: "complete",
					event: "watcher.reconcile_enqueued",
				}),
				expect.objectContaining({
					type: "complete",
					event: "watcher.stopped",
				}),
			]),
		);
	});

	it("marks the account for reconnect when no token is available", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-2",
			syncEnabled: 1,
		});
		await insertSyncState("acct-2");

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-2");

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-2")
			.executeTakeFirstOrThrow();
		const syncState = await db
			.selectFrom("account_sync_state")
			.select(["watcher_status"])
			.where("account_id", "=", "acct-2")
			.executeTakeFirstOrThrow();

		expect(account.sync_status).toBe("needs_reconnect");
		expect(syncState.watcher_status).toBe("error");
		expect(watchers.getWatcherStatus("acct-2")).toBe("stopped");
	});

	it("stopping an unknown watcher is a no-op", async () => {
		const runtime = await createTestRuntime();
		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);

		await expect(watchers.stopWatcher("missing")).resolves.toBeUndefined();
	});

	it("reconnects after a close event", async () => {
		const runtime = await createTestRuntime();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-3",
			syncEnabled: 1,
		});
		await insertSyncState("acct-3");

		const firstClient = createMockClient();
		const secondClient = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi
				.fn()
				.mockImplementationOnce(() => firstClient)
				.mockImplementationOnce(() => secondClient),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-3");

		firstClient.emit("close");
		await vi.advanceTimersByTimeAsync(1);
		await Promise.resolve();

		expect(firstClient.lock.release).toHaveBeenCalled();
		expect(firstClient.logout).toHaveBeenCalled();
		expect(secondClient.connect).toHaveBeenCalled();
		expect(watchers.getWatcherStatus("acct-3")).toBe("running");
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "watcher.closed",
				}),
			]),
		);
	});

	it("reconnects after a close event when client logout fails", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-3b",
			syncEnabled: 1,
		});
		await insertSyncState("acct-3b");

		const firstClient = createMockClient();
		firstClient.logout.mockRejectedValueOnce(new Error("logout failed"));
		const secondClient = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi
				.fn()
				.mockImplementationOnce(() => firstClient)
				.mockImplementationOnce(() => secondClient),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-3b");

		firstClient.emit("close");
		await vi.advanceTimersByTimeAsync(1);
		await Promise.resolve();

		expect(firstClient.lock.release).toHaveBeenCalled();
		expect(firstClient.logout).toHaveBeenCalled();
		expect(secondClient.connect).toHaveBeenCalled();
		expect(watchers.getWatcherStatus("acct-3b")).toBe("running");
	});

	it("backs off after connect failures and retries later", async () => {
		const runtime = await createTestRuntime();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-4",
			syncEnabled: 1,
		});
		await insertSyncState("acct-4");

		const failingClient = createMockClient();
		failingClient.connect.mockRejectedValueOnce("imap down");
		const recoveredClient = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi
				.fn()
				.mockImplementationOnce(() => failingClient)
				.mockImplementationOnce(() => recoveredClient),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-4");

		const failedState = await db
			.selectFrom("account_sync_state")
			.select(["watcher_status", "consecutive_failures", "backoff_until"])
			.where("account_id", "=", "acct-4")
			.executeTakeFirstOrThrow();
		const failedAccount = await db
			.selectFrom("accounts")
			.select(["last_error"])
			.where("id", "=", "acct-4")
			.executeTakeFirstOrThrow();

		expect(failedState.watcher_status).toBe("error");
		expect(failedState.consecutive_failures).toBe(3);
		expect(failedState.backoff_until).toBeTruthy();
		expect(failedAccount.last_error).toBe("imap down");

		await vi.advanceTimersByTimeAsync(8_000);

		const recoveredState = await db
			.selectFrom("account_sync_state")
			.select(["watcher_status", "consecutive_failures"])
			.where("account_id", "=", "acct-4")
			.executeTakeFirstOrThrow();
		expect(recoveredClient.connect).toHaveBeenCalled();
		expect(recoveredState.watcher_status).toBe("idle");
		expect(recoveredState.consecutive_failures).toBe(0);
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "fail",
					event: "watcher.error",
				}),
				expect.objectContaining({
					type: "info",
					event: "watcher.reconnect_scheduled",
					fields: expect.objectContaining({ backoff_ms: 8000 }),
				}),
			]),
		);
	});

	it("clears pending reconnect timers when a failed watcher is stopped", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-4b",
			syncEnabled: 1,
		});
		await insertSyncState("acct-4b");

		const failingClient = createMockClient();
		failingClient.connect.mockRejectedValueOnce(new Error("imap down"));
		const recoveredClient = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi
				.fn()
				.mockImplementationOnce(() => failingClient)
				.mockImplementationOnce(() => recoveredClient),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-4b");
		await watchers.stopWatcher("acct-4b");
		await vi.advanceTimersByTimeAsync(8_000);

		expect(recoveredClient.connect).not.toHaveBeenCalled();
		expect(watchers.getWatcherStatus("acct-4b")).toBe("stopped");
	});

	it("records reconnect failures that happen after a close event", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-6",
			syncEnabled: 1,
		});
		await insertSyncState("acct-6");

		const firstClient = createMockClient();
		const secondClient = createMockClient();
		secondClient.connect.mockRejectedValueOnce(new Error("reconnect failed"));

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi
				.fn()
				.mockImplementationOnce(() => firstClient)
				.mockImplementationOnce(() => secondClient),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-6");
		firstClient.emit("close");
		await vi.advanceTimersByTimeAsync(1);
		await Promise.resolve();

		const account = await db
			.selectFrom("accounts")
			.select(["last_error"])
			.where("id", "=", "acct-6")
			.executeTakeFirstOrThrow();
		expect(account.last_error).toBe("reconnect failed");
	});

	it("backs off from zero when connect fails before sync state exists", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-7",
			syncEnabled: 1,
		});

		const failingClient = createMockClient();
		failingClient.connect.mockRejectedValueOnce(
			new Error("initial connect failed"),
		);

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => failingClient),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-7");

		const account = await db
			.selectFrom("accounts")
			.select(["last_error"])
			.where("id", "=", "acct-7")
			.executeTakeFirstOrThrow();
		expect(account.last_error).toBe("initial connect failed");
	});

	it("ignores cleanup failures when stopping a watcher", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-5",
			syncEnabled: 1,
		});
		await insertSyncState("acct-5");

		const client = createMockClient();
		client.lock.release.mockImplementationOnce(() => {
			throw new Error("release failed");
		});
		client.logout.mockRejectedValueOnce(new Error("logout failed"));

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.startWatcher("acct-5");

		await expect(watchers.stopWatcher("acct-5")).resolves.toBeUndefined();
		expect(watchers.getWatcherStatus("acct-5")).toBe("stopped");
	});

	it("restores watchers only for enabled gmail accounts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-live",
			syncEnabled: 1,
		});
		await seedTestAccount(db, {
			id: "acct-disabled",
			syncEnabled: 0,
		});
		await insertSyncState("acct-live");

		const createImapClient = vi.fn();
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async (accountId: string) =>
				accountId === "acct-live" ? null : null,
			),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient,
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return actual;
		});

		const watchers =
			await runtime.importFresh<typeof import("#/lib/watchers")>(
				"#/lib/watchers",
			);
		await watchers.restoreWatchers();

		expect(createImapClient).not.toHaveBeenCalled();
		const liveAccount = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-live")
			.executeTakeFirstOrThrow();
		expect(liveAccount.sync_status).toBe("needs_reconnect");
	});
});
