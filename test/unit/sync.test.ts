import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertConversationRow,
	seedTestAccount,
} from "#/test/helpers/db";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

async function insertSyncState(
	accountId: string,
	input?: Partial<{
		uidvalidity: number | null;
		latest_uid_cursor: number | null;
		earliest_uid_cursor: number | null;
		backfill_snapshot_uid: number | null;
		backfill_next_uid: number | null;
		last_bootstrap_started_at: string | null;
		last_bootstrap_completed_at: string | null;
		last_delta_sync_at: string | null;
		last_reconcile_at: string | null;
		last_backfill_sync_at: string | null;
		backfill_completed_at: string | null;
		watcher_status: string;
		consecutive_failures: number;
		backoff_until: string | null;
	}>,
) {
	const { getDb } = await import("#/lib/db");
	const db = getDb();
	const now = "2026-01-01T00:00:00.000Z";
	await db
		.insertInto("account_sync_state")
		.values({
			account_id: accountId,
			uidvalidity:
				input && "uidvalidity" in input ? (input.uidvalidity ?? null) : 100,
			latest_uid_cursor: input?.latest_uid_cursor ?? null,
			earliest_uid_cursor: input?.earliest_uid_cursor ?? null,
			backfill_snapshot_uid: input?.backfill_snapshot_uid ?? null,
			backfill_next_uid: input?.backfill_next_uid ?? null,
			last_bootstrap_started_at:
				input && "last_bootstrap_started_at" in input
					? (input.last_bootstrap_started_at ?? null)
					: now,
			last_bootstrap_completed_at:
				input && "last_bootstrap_completed_at" in input
					? (input.last_bootstrap_completed_at ?? null)
					: now,
			last_delta_sync_at: input?.last_delta_sync_at ?? null,
			last_reconcile_at: input?.last_reconcile_at ?? null,
			last_backfill_sync_at: input?.last_backfill_sync_at ?? null,
			backfill_completed_at: input?.backfill_completed_at ?? null,
			last_idle_started_at: null,
			last_idle_heartbeat_at: null,
			watcher_status: input?.watcher_status ?? "stopped",
			consecutive_failures: input?.consecutive_failures ?? 0,
			backoff_until: input?.backoff_until ?? null,
			created_at: now,
			updated_at: now,
		})
		.execute();
}

function createMockClient(
	fetchImpl?: () => AsyncGenerator<Record<string, unknown>>,
) {
	return {
		connect: vi.fn(async () => undefined),
		getMailboxLock: vi.fn(async () => ({
			release: vi.fn(),
		})),
		logout: vi.fn(async () => undefined),
		fetch:
			fetchImpl ??
			async function* () {
				yield* [];
			},
	};
}

function createParsedMessage(id: string, sha: string) {
	return {
		id,
		messageId: `<${id}@example.com>`,
		threadKey: `thread-${id}`,
		receivedAt: "2026-01-01T00:00:00.000Z",
		senderName: "Sender",
		senderAddress: "sender@example.com",
		toJson: "[]",
		ccJson: "[]",
		subject: `Subject ${id}`,
		inReplyTo: null,
		bodyTextPrimary: "body",
		bodyTextForwarded: "",
		bodyTextNormalized: "body",
		snippet: "body",
		attachmentCount: 0,
		hasHtml: 0,
		parseStatus: "parsed",
		bodyExtractionStrategy: "plain_text",
		parseErrorReason: null,
		tokenEstimate: 1,
		contentSha256: sha,
		attachments: [],
	};
}

function createFetchedMessage(uid: number) {
	return {
		uid,
		gmMsgId: `gm-${uid}`,
		gmThrid: `thr-${uid}`,
		internalDate: new Date(
			`2026-01-${String(uid).padStart(2, "0")}T00:00:00.000Z`,
		),
		raw: Buffer.from(`raw-${uid}`),
		sha256: `sha-${uid}`,
	};
}

function mockFreshToken(accessToken: string | null) {
	vi.doMock("#/lib/google-oauth", () => ({
		ensureFreshToken: vi.fn(async () =>
			accessToken === null ? null : { accessToken },
		),
	}));
}

function mockFreshTokenError(message: string) {
	vi.doMock("#/lib/google-oauth", () => ({
		ensureFreshToken: vi.fn(async () => {
			throw new Error(message);
		}),
	}));
}

function mockQueueJobIdempotent(
	impl: (input: {
		kind: string;
		scopeType: string;
		scopeId: string;
	}) => Promise<string | null> = async () => null,
) {
	const queueJobIdempotent = vi.fn(impl);
	vi.doMock("#/lib/jobs", () => ({
		queueJobIdempotent,
	}));
	return queueJobIdempotent;
}

function mockImap(input?: {
	client?: ReturnType<typeof createMockClient>;
	fetchMessageRange?: (...args: unknown[]) => Promise<unknown[]>;
	fetchMessageWindowDescending?: (...args: unknown[]) => Promise<unknown[]>;
	getMailboxStatus?: (...args: unknown[]) => Promise<{
		uidvalidity: number;
		uidNext: number;
		messageCount: number;
	}>;
	parseRawMessage?: (...args: unknown[]) => Promise<unknown>;
	writeRawEml?: (...args: unknown[]) => string;
}) {
	const client = input?.client ?? createMockClient();
	const fetchMessageRange = vi.fn(input?.fetchMessageRange ?? (async () => []));
	const fetchMessageWindowDescending = vi.fn(
		input?.fetchMessageWindowDescending ?? (async () => []),
	);
	const getMailboxStatus = vi.fn(
		input?.getMailboxStatus ??
			(async () => ({
				uidvalidity: 100,
				uidNext: 1,
				messageCount: 0,
			})),
	);
	const parseRawMessage = vi.fn(
		input?.parseRawMessage ??
			(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha)),
	);
	const writeRawEml = vi.fn(input?.writeRawEml ?? (() => "/tmp/raw.eml"));

	vi.doMock("#/lib/imap", () => ({
		createImapClient: vi.fn(() => client),
		fetchMessageRange,
		fetchMessageWindowDescending,
		getMailboxStatus,
		parseRawMessage,
		writeRawEml,
	}));

	return {
		client,
		fetchMessageRange,
		fetchMessageWindowDescending,
		getMailboxStatus,
		parseRawMessage,
		writeRawEml,
	};
}

describe("sync", () => {
	it("bootstraps the newest window and seeds resumable backfill cursors", async () => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "3";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-bootstrap",
			syncEnabled: 1,
		});

		const queueJobIdempotent = vi.fn(async () => "job-backfill");
		const fetchMessageRange = vi.fn(async () => [
			createFetchedMessage(3),
			createFetchedMessage(4),
			createFetchedMessage(5),
		]);
		const client = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent,
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
			fetchMessageRange,
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 111,
				uidNext: 6,
				messageCount: 5,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha),
			),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runFullSync("acct-bootstrap");

		expect(result).toMatchObject({
			skipped: false,
			phase: "bootstrap",
			fetched: 3,
			latestUidCursor: 5,
			earliestUidCursor: 3,
			backfillSnapshotUid: 5,
			backfillNextUid: 2,
			queuedBackfill: true,
		});
		expect(fetchMessageRange).toHaveBeenCalledWith(expect.anything(), 3, 5);
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "acct-bootstrap",
		});

		const syncState = await db
			.selectFrom("account_sync_state")
			.selectAll()
			.where("account_id", "=", "acct-bootstrap")
			.executeTakeFirstOrThrow();
		expect(syncState).toMatchObject({
			uidvalidity: 111,
			latest_uid_cursor: 5,
			earliest_uid_cursor: 3,
			backfill_snapshot_uid: 5,
			backfill_next_uid: 2,
		});

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-bootstrap")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("backfilling");
	});

	it("completes bootstrap immediately for an empty mailbox", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-empty",
			syncEnabled: 1,
		});

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => "job"),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 222,
				uidNext: 1,
				messageCount: 0,
			})),
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runFullSync("acct-empty");

		expect(result).toMatchObject({
			phase: "bootstrap",
			fetched: 0,
			backfillNextUid: null,
			queuedBackfill: false,
		});
		const syncState = await db
			.selectFrom("account_sync_state")
			.select(["backfill_completed_at", "latest_uid_cursor"])
			.where("account_id", "=", "acct-empty")
			.executeTakeFirstOrThrow();
		expect(syncState.latest_uid_cursor).toBeNull();
		expect(syncState.backfill_completed_at).toBeTruthy();
	});

	it("resumes an existing epoch, advances one head window, and queues follow-up work", async () => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "2";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-resume",
			syncEnabled: 1,
		});
		await insertSyncState("acct-resume", {
			uidvalidity: 100,
			latest_uid_cursor: 5,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 5,
			backfill_next_uid: 4,
		});

		const queueJobIdempotent = vi.fn(async () => "job-next");
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent,
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				createFetchedMessage(6),
				createFetchedMessage(7),
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 10,
				messageCount: 9,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha),
			),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runFullSync("acct-resume");

		expect(result).toMatchObject({
			phase: "resume",
			fetched: 2,
			latestUidCursor: 7,
			backfillNextUid: 4,
			queuedBackfill: true,
			queuedDelta: true,
		});
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-resume",
		});
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "acct-resume",
		});
	});

	it("delta sync ingests one head window and requeues more head work", async () => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "2";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta",
			syncEnabled: 1,
		});
		await insertSyncState("acct-delta", {
			uidvalidity: 100,
			latest_uid_cursor: 4,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 4,
			backfill_next_uid: 2,
		});

		const queueJobIdempotent = vi.fn(async () => "job-next");
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent,
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				createFetchedMessage(5),
				createFetchedMessage(6),
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 9,
				messageCount: 8,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha),
			),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runDeltaSync("acct-delta");

		expect(result).toMatchObject({
			fetched: 2,
			uidvalidityChanged: false,
			latestUidCursor: 6,
			backfillNextUid: 2,
			queuedMore: true,
		});

		const syncState = await db
			.selectFrom("account_sync_state")
			.select(["latest_uid_cursor"])
			.where("account_id", "=", "acct-delta")
			.executeTakeFirstOrThrow();
		expect(syncState.latest_uid_cursor).toBe(6);
	});

	it("delta sync marks resync_required and queues bootstrap when uidvalidity drifts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-drift",
			syncEnabled: 1,
		});
		await insertSyncState("acct-drift", {
			uidvalidity: 100,
			latest_uid_cursor: 5,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 5,
			backfill_next_uid: null,
		});

		const queueJobIdempotent = vi.fn(async () => "job-full");
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent,
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 101,
				uidNext: 6,
				messageCount: 5,
			})),
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runDeltaSync("acct-drift");

		expect(result.uidvalidityChanged).toBe(true);
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-drift",
		});

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-drift")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("resync_required");
	});

	it("backfill sync processes one descending window and requeues more history", async () => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "3";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill",
			syncEnabled: 1,
		});
		await insertSyncState("acct-backfill", {
			uidvalidity: 100,
			latest_uid_cursor: 10,
			earliest_uid_cursor: 6,
			backfill_snapshot_uid: 10,
			backfill_next_uid: 5,
		});

		const queueJobIdempotent = vi.fn(async () => "job-backfill");
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent,
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(async () => [
				createFetchedMessage(5),
				createFetchedMessage(4),
				createFetchedMessage(3),
			]),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 11,
				messageCount: 10,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha),
			),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runBackfillSync("acct-backfill");

		expect(result).toMatchObject({
			fetched: 3,
			earliestUidCursor: 3,
			backfillNextUid: 2,
			rangeStart: 3,
			rangeEnd: 5,
			queuedMore: true,
		});
	});

	it("backfill sync completes at uid 1 and returns the account to idle", async () => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "3";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-final",
			syncEnabled: 1,
			syncStatus: "backfilling",
		});
		await insertSyncState("acct-backfill-final", {
			uidvalidity: 100,
			latest_uid_cursor: 10,
			earliest_uid_cursor: 3,
			backfill_snapshot_uid: 10,
			backfill_next_uid: 2,
		});

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => "job-backfill"),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(async () => [
				createFetchedMessage(2),
				createFetchedMessage(1),
			]),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 11,
				messageCount: 10,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha),
			),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runBackfillSync("acct-backfill-final");

		expect(result.backfillNextUid).toBeNull();
		const account = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-backfill-final")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("idle");
	});

	it("skips remote sync work for paused accounts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-paused",
			syncEnabled: 0,
			syncStatus: "paused",
		});

		const ensureFreshToken = vi.fn();
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken,
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(),
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runFullSync("acct-paused");

		expect(result.skipped).toBe(true);
		expect(ensureFreshToken).not.toHaveBeenCalled();
	});

	it.each([
		[
			"has a null uidvalidity",
			{
				uidvalidity: null,
				latest_uid_cursor: 5,
				earliest_uid_cursor: 1,
				backfill_snapshot_uid: 5,
				backfill_next_uid: null,
			},
		],
		[
			"has a mismatched uidvalidity",
			{
				uidvalidity: 99,
				latest_uid_cursor: 5,
				earliest_uid_cursor: 1,
				backfill_snapshot_uid: 5,
				backfill_next_uid: null,
			},
		],
		[
			"never completed bootstrap",
			{
				uidvalidity: 100,
				latest_uid_cursor: 5,
				earliest_uid_cursor: 1,
				backfill_snapshot_uid: 5,
				backfill_next_uid: null,
				last_bootstrap_completed_at: null,
			},
		],
		[
			"is missing bootstrap cursors",
			{
				uidvalidity: 100,
				latest_uid_cursor: null,
				earliest_uid_cursor: null,
				backfill_snapshot_uid: null,
				backfill_next_uid: null,
			},
		],
	])("bootstraps again when sync state %s", async (_label, input) => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "3";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-bootstrap-guard",
			syncEnabled: 1,
		});
		await insertSyncState("acct-bootstrap-guard", input);

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		const imap = mockImap({
			fetchMessageRange: async () => [
				createFetchedMessage(4),
				createFetchedMessage(5),
			],
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 6,
				messageCount: 5,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runFullSync("acct-bootstrap-guard");

		expect(result.phase).toBe("bootstrap");
		expect(imap.fetchMessageRange).toHaveBeenCalledWith(
			expect.anything(),
			3,
			5,
		);
	});

	it("marks the account as needs_reconnect when bootstrap has no valid token", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-full-token",
			syncEnabled: 1,
		});

		mockFreshToken(null);
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runFullSync("acct-full-token")).rejects.toThrow(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status", "last_error"])
			.where("id", "=", "acct-full-token")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("needs_reconnect");
		expect(account.last_error).toBe(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);
	});

	it("preserves account status and records bootstrap config failure when token refresh throws", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-full-bootstrap-error",
			syncEnabled: 1,
			syncStatus: "idle",
		});

		mockFreshTokenError(
			"Google OAuth client credentials were rejected by Google. Verify GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for redirect URL http://127.0.0.1:56711/oauth/google/callback. Start local server with mise run dev.",
		);
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runFullSync("acct-full-bootstrap-error")).rejects.toThrow(
			"Google OAuth client credentials were rejected by Google.",
		);

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status", "last_error"])
			.where("id", "=", "acct-full-bootstrap-error")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("idle");
		expect(account.last_error).toContain(
			"Google OAuth client credentials were rejected by Google.",
		);
	});

	it("ignores logout errors after a successful bootstrap", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-full-logout",
			syncEnabled: 1,
		});

		const client = createMockClient();
		client.logout = vi.fn(async () => {
			throw new Error("logout failed");
		});
		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			client,
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 1,
				messageCount: 0,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runFullSync("acct-full-logout")).resolves.toMatchObject({
			skipped: false,
			phase: "bootstrap",
		});
	});

	it("resumes empty-head epochs without forcing a fresh bootstrap", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-resume-empty-head",
			syncEnabled: 1,
		});
		await insertSyncState("acct-resume-empty-head", {
			uidvalidity: 100,
			latest_uid_cursor: null,
			earliest_uid_cursor: null,
			backfill_snapshot_uid: null,
			backfill_next_uid: null,
			last_bootstrap_completed_at: "2026-01-01T00:05:00.000Z",
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		const imap = mockImap({
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 1,
				messageCount: 0,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runFullSync("acct-resume-empty-head"),
		).resolves.toMatchObject({
			phase: "resume",
			fetched: 0,
		});
		expect(imap.fetchMessageRange).not.toHaveBeenCalled();
	});

	it("surfaces bootstrap failures through the failure path", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-full-error",
			syncEnabled: 1,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			getMailboxStatus: async () => {
				throw new Error("mailbox status failed");
			},
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runFullSync("acct-full-error")).rejects.toThrow(
			"mailbox status failed",
		);
	});

	it("skips delta work for paused accounts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta-paused",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await insertSyncState("acct-delta-paused");

		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-delta-paused")).resolves.toMatchObject(
			{
				skipped: true,
				fetched: 0,
			},
		);
	});

	it("requires sync state before delta work can run", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta-missing-state",
			syncEnabled: 1,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-delta-missing-state")).rejects.toThrow(
			"No sync state found; run full sync first",
		);
	});

	it("marks the account as needs_reconnect when delta has no valid token", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta-token",
			syncEnabled: 1,
		});
		await insertSyncState("acct-delta-token");

		mockFreshToken(null);
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-delta-token")).rejects.toThrow(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status", "last_error"])
			.where("id", "=", "acct-delta-token")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("needs_reconnect");
		expect(account.last_error).toBe(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);
	});

	it("ignores logout errors after delta sync succeeds", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta-logout",
			syncEnabled: 1,
		});
		await insertSyncState("acct-delta-logout", {
			latest_uid_cursor: 1,
			backfill_next_uid: null,
		});

		const client = createMockClient();
		client.logout = vi.fn(async () => {
			throw new Error("logout failed");
		});
		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			client,
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-delta-logout")).resolves.toMatchObject(
			{
				skipped: false,
				fetched: 0,
			},
		);
	});

	it("seeds delta cursors from null state when head mail exists", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta-seed",
			syncEnabled: 1,
		});
		await insertSyncState("acct-delta-seed", {
			uidvalidity: 100,
			latest_uid_cursor: null,
			earliest_uid_cursor: null,
			backfill_snapshot_uid: null,
			backfill_next_uid: null,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			fetchMessageRange: async () => [createFetchedMessage(1)],
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-delta-seed")).resolves.toMatchObject({
			skipped: false,
			fetched: 1,
			latestUidCursor: 1,
		});

		const syncState = await db
			.selectFrom("account_sync_state")
			.select(["earliest_uid_cursor"])
			.where("account_id", "=", "acct-delta-seed")
			.executeTakeFirstOrThrow();
		expect(syncState.earliest_uid_cursor).toBe(1);
	});

	it("surfaces delta failures through the failure path", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delta-error",
			syncEnabled: 1,
		});
		await insertSyncState("acct-delta-error");

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			getMailboxStatus: async () => {
				throw new Error("delta status failed");
			},
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-delta-error")).rejects.toThrow(
			"delta status failed",
		);
	});

	it("skips backfill work for paused accounts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-paused",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await insertSyncState("acct-backfill-paused", {
			backfill_next_uid: 3,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runBackfillSync("acct-backfill-paused"),
		).resolves.toMatchObject({
			skipped: true,
			fetched: 0,
		});
	});

	it("requires sync state before backfill work can run", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-missing-state",
			syncEnabled: 1,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runBackfillSync("acct-backfill-missing-state"),
		).rejects.toThrow("No sync state found; run full sync first");
	});

	it("treats null backfill_next_uid as already-complete historical sync", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-complete",
			syncEnabled: 1,
		});
		await insertSyncState("acct-backfill-complete", {
			earliest_uid_cursor: 1,
			backfill_next_uid: null,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runBackfillSync("acct-backfill-complete"),
		).resolves.toMatchObject({
			skipped: false,
			fetched: 0,
			backfillNextUid: null,
			earliestUidCursor: 1,
		});
	});

	it("marks the account as needs_reconnect when backfill has no valid token", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-token",
			syncEnabled: 1,
		});
		await insertSyncState("acct-backfill-token", {
			backfill_next_uid: 3,
		});

		mockFreshToken(null);
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runBackfillSync("acct-backfill-token")).rejects.toThrow(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status", "last_error"])
			.where("id", "=", "acct-backfill-token")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("needs_reconnect");
		expect(account.last_error).toBe(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);
	});

	it("requeues a fresh bootstrap when backfill sees uidvalidity drift", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-drift",
			syncEnabled: 1,
		});
		await insertSyncState("acct-backfill-drift", {
			uidvalidity: 100,
			earliest_uid_cursor: 6,
			backfill_next_uid: 5,
		});

		mockFreshToken("access-token");
		const queueJobIdempotent = mockQueueJobIdempotent(async () => "job-full");
		mockImap({
			getMailboxStatus: async () => ({
				uidvalidity: 101,
				uidNext: 11,
				messageCount: 10,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runBackfillSync("acct-backfill-drift"),
		).resolves.toMatchObject({
			uidvalidityChanged: true,
		});
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-backfill-drift",
		});
	});

	it("ignores logout errors after backfill succeeds", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-logout",
			syncEnabled: 1,
		});
		await insertSyncState("acct-backfill-logout", {
			uidvalidity: 100,
			earliest_uid_cursor: 3,
			backfill_next_uid: 2,
		});

		const client = createMockClient();
		client.logout = vi.fn(async () => {
			throw new Error("logout failed");
		});
		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			client,
			fetchMessageWindowDescending: async () => [],
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 3,
				messageCount: 2,
			}),
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runBackfillSync("acct-backfill-logout"),
		).resolves.toMatchObject({
			skipped: false,
			fetched: 0,
		});
	});

	it("surfaces backfill failures through the failure path", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill-error",
			syncEnabled: 1,
		});
		await insertSyncState("acct-backfill-error", {
			uidvalidity: 100,
			earliest_uid_cursor: 3,
			backfill_next_uid: 2,
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 3,
				messageCount: 2,
			}),
			fetchMessageWindowDescending: async () => {
				throw new Error("backfill failed");
			},
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runBackfillSync("acct-backfill-error")).rejects.toThrow(
			"backfill failed",
		);
	});

	it("skips reconcile for paused accounts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile-paused",
			syncEnabled: 0,
			syncStatus: "paused",
		});

		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runReconcile("acct-reconcile-paused")).resolves.toEqual({
			skipped: true,
			tombstoned: 0,
		});
	});

	it("marks the account as needs_reconnect when reconcile has no valid token", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile-token",
			syncEnabled: 1,
		});
		await insertSyncState("acct-reconcile-token", {
			latest_uid_cursor: 1,
			earliest_uid_cursor: 1,
			backfill_next_uid: null,
		});

		mockFreshToken(null);
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runReconcile("acct-reconcile-token")).rejects.toThrow(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status", "last_error"])
			.where("id", "=", "acct-reconcile-token")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("needs_reconnect");
		expect(account.last_error).toBe(
			"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.",
		);
	});

	it("skips reconcile when the tracked sync window is unavailable", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile-no-window",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		await insertSyncState("acct-reconcile-no-window", {
			latest_uid_cursor: null,
			earliest_uid_cursor: null,
			last_reconcile_at: null,
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runReconcile("acct-reconcile-no-window"),
		).resolves.toEqual({
			skipped: true,
			tombstoned: 0,
		});

		const syncState = await db
			.selectFrom("account_sync_state")
			.select(["last_reconcile_at"])
			.where("account_id", "=", "acct-reconcile-no-window")
			.executeTakeFirstOrThrow();
		expect(syncState.last_reconcile_at).toBeNull();
	});

	it("marks resync_required and queues bootstrap when reconcile sees uidvalidity drift", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile-drift",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		await insertSyncState("acct-reconcile-drift", {
			uidvalidity: 100,
			latest_uid_cursor: 3,
			earliest_uid_cursor: 2,
			backfill_next_uid: null,
			last_reconcile_at: null,
		});

		const queueJobIdempotent = vi.fn(async () => "job-full");
		const client = createMockClient();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent,
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 200,
				uidNext: 4,
				messageCount: 3,
			})),
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runReconcile("acct-reconcile-drift")).resolves.toEqual({
			skipped: true,
			tombstoned: 0,
		});

		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-reconcile-drift",
		});
		expect(client.getMailboxLock).not.toHaveBeenCalled();

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-reconcile-drift")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("resync_required");

		const syncState = await db
			.selectFrom("account_sync_state")
			.select(["last_reconcile_at"])
			.where("account_id", "=", "acct-reconcile-drift")
			.executeTakeFirstOrThrow();
		expect(syncState.last_reconcile_at).toBeNull();
	});

	it("uses child traces when sync entrypoints receive a parent trace", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const log = createMockLogModule();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-trace-full",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await seedTestAccount(db, {
			id: "acct-trace-delta",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await seedTestAccount(db, {
			id: "acct-trace-backfill",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await seedTestAccount(db, {
			id: "acct-trace-reconcile",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await insertSyncState("acct-trace-delta");
		await insertSyncState("acct-trace-backfill", {
			backfill_next_uid: 1,
		});

		vi.doMock("#/lib/log", () => log.module);
		mockFreshToken("access-token");
		mockQueueJobIdempotent();

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const parentTrace = log.module.startTrace({
			kind: "worker",
			operation: "parent_trace",
		});

		await sync.runFullSync("acct-trace-full", parentTrace);
		await sync.runDeltaSync("acct-trace-delta", parentTrace);
		await sync.runBackfillSync("acct-trace-backfill", parentTrace);
		await sync.runReconcile("acct-trace-reconcile", parentTrace);

		expect(
			log.records.filter((record) => record.type === "child").length,
		).toBeGreaterThanOrEqual(4);
	});

	it("reconcile preserves backfilling accounts", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile",
			syncEnabled: 1,
			syncStatus: "backfilling",
		});
		await insertSyncState("acct-reconcile", {
			latest_uid_cursor: 1,
			earliest_uid_cursor: 1,
			backfill_next_uid: 3,
		});

		const messageId = "msg-reconcile";
		await db
			.insertInto("messages")
			.values({
				id: messageId,
				account_id: "acct-reconcile",
				message_id: "<msg-reconcile@example.com>",
				thread_key: "thread-reconcile",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Sender",
				sender_address: "sender@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Subject",
				in_reply_to: null,
				body_text_primary: "body",
				body_text_forwarded: "",
				body_text_normalized: "body",
				snippet: "body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-reconcile",
				message_id: messageId,
				account_id: "acct-reconcile",
				remote_message_id: "gm-reconcile",
				remote_thread_id: "thr-reconcile",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/reconcile.eml",
				raw_sha256: "sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const client = createMockClient(async function* () {
			yield {
				emailId: "gm-reconcile",
			};
		});

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.runReconcile("acct-reconcile");
		expect(result).toEqual({ skipped: false, tombstoned: 0 });

		const account = await db
			.selectFrom("accounts")
			.select(["sync_status"])
			.where("id", "=", "acct-reconcile")
			.executeTakeFirstOrThrow();
		expect(account.sync_status).toBe("backfilling");
	});

	it("reconcile tombstones missing remote messages and ignores logout errors", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-tombstone",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		await insertSyncState("acct-tombstone", {
			latest_uid_cursor: 3,
			earliest_uid_cursor: 2,
			backfill_next_uid: null,
		});

		await db
			.insertInto("messages")
			.values({
				id: "msg-tombstone",
				account_id: "acct-tombstone",
				message_id: "<msg-tombstone@example.com>",
				thread_key: "thread-tombstone",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Sender",
				sender_address: "sender@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Subject",
				in_reply_to: null,
				body_text_primary: "body",
				body_text_forwarded: "",
				body_text_normalized: "body",
				snippet: "body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-tombstone",
				message_id: "msg-tombstone",
				account_id: "acct-tombstone",
				remote_message_id: "gm-missing",
				remote_thread_id: "thr-missing",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 2,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/tombstone.eml",
				raw_sha256: "sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-outside-window",
				message_id: "msg-tombstone",
				account_id: "acct-tombstone",
				remote_message_id: "gm-outside-window",
				remote_thread_id: "thr-outside-window",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/tombstone-outside.eml",
				raw_sha256: "sha-outside",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const client = {
			connect: vi.fn(async () => undefined),
			getMailboxLock: vi.fn(async () => ({
				release: vi.fn(),
			})),
			logout: vi.fn(async () => {
				throw new Error("logout failed");
			}),
			fetch: vi.fn(async function* () {
				yield {
					emailId: "gm-other",
				};
			}),
		};
		const getMailboxStatus = vi.fn(async () => ({
			uidvalidity: 100,
			uidNext: 4,
			messageCount: 3,
		}));

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus,
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runReconcile("acct-tombstone")).resolves.toEqual({
			skipped: false,
			tombstoned: 1,
		});

		const source = await db
			.selectFrom("message_sources")
			.select(["state", "tombstoned_at"])
			.where("id", "=", "src-tombstone")
			.executeTakeFirstOrThrow();
		expect(source.state).toBe("tombstoned");
		expect(source.tombstoned_at).toBeTruthy();
		expect(client.fetch).toHaveBeenCalledWith(
			"2:3",
			{
				uid: true,
				emailId: true,
			},
			{ uid: true },
		);

		const outsideWindow = await db
			.selectFrom("message_sources")
			.select(["state", "tombstoned_at"])
			.where("id", "=", "src-outside-window")
			.executeTakeFirstOrThrow();
		expect(outsideWindow.state).toBe("active");
		expect(outsideWindow.tombstoned_at).toBeNull();
	});

	it("reconcile surfaces IMAP failures through the structured failure path", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile-error",
			syncEnabled: 1,
		});
		await insertSyncState("acct-reconcile-error", {
			latest_uid_cursor: 1,
			earliest_uid_cursor: 1,
			backfill_next_uid: null,
		});

		const client = {
			connect: vi.fn(async () => undefined),
			getMailboxLock: vi.fn(async () => ({
				release: vi.fn(),
			})),
			logout: vi.fn(async () => undefined),
			fetch: vi.fn(() => {
				throw new Error("imap fetch failed");
			}),
		};

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => client),
			fetchMessageRange: vi.fn(),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(),
			writeRawEml: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runReconcile("acct-reconcile-error")).rejects.toThrow(
			"imap fetch failed",
		);
	});

	it("updates existing mirrored messages when the raw source changes", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing",
			syncEnabled: 1,
		});
		await insertSyncState("acct-existing", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 1,
			backfill_next_uid: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-existing",
				account_id: "acct-existing",
				message_id: "<msg-existing@example.com>",
				thread_key: "thread-existing",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Old Sender",
				sender_address: "old@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Old subject",
				in_reply_to: null,
				body_text_primary: "old body",
				body_text_forwarded: "",
				body_text_normalized: "old body",
				snippet: "old body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "old-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-existing",
				message_id: "msg-existing",
				account_id: "acct-existing",
				remote_message_id: "gm-existing",
				remote_thread_id: "thr-existing",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/old.eml",
				raw_sha256: "old-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				{
					uid: 1,
					gmMsgId: "gm-existing",
					gmThrid: "thr-existing",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("new raw"),
					sha256: "new-sha",
				},
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(async () => ({
				id: "ignored-id",
				messageId: "<msg-existing@example.com>",
				threadKey: "thread-existing",
				receivedAt: null,
				senderName: "New Sender",
				senderAddress: "new@example.com",
				toJson: "[]",
				ccJson: "[]",
				subject: "New subject",
				inReplyTo: null,
				bodyTextPrimary: "new body",
				bodyTextForwarded: "",
				bodyTextNormalized: "new body",
				snippet: "new body",
				attachmentCount: 1,
				hasHtml: 0,
				parseStatus: "parsed",
				bodyExtractionStrategy: "plain_text",
				parseErrorReason: null,
				tokenEstimate: 2,
				contentSha256: "new-sha",
				attachments: [
					{
						id: "att-new",
						filename: "invoice.pdf",
						mimeType: "application/pdf",
						sizeBytes: 128,
						contentId: null,
						isInline: 0,
					},
				],
			})),
			writeRawEml: vi.fn(() => "/tmp/new.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runDeltaSync("acct-existing");

		const message = await db
			.selectFrom("messages")
			.select(["subject", "sender_address", "content_sha256"])
			.where("id", "=", "msg-existing")
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			subject: "New subject",
			sender_address: "new@example.com",
			content_sha256: "new-sha",
		});
		const source = await db
			.selectFrom("message_sources")
			.select(["raw_sha256", "raw_rfc822_path", "imap_uid"])
			.where("id", "=", "src-existing")
			.executeTakeFirstOrThrow();
		expect(source).toEqual({
			raw_sha256: "new-sha",
			raw_rfc822_path: "/tmp/new.eml",
			imap_uid: 1,
		});
		const attachments = await db
			.selectFrom("attachments")
			.select(["filename", "mime_type", "size_bytes"])
			.where("message_id", "=", "msg-existing")
			.execute();
		expect(attachments).toEqual([
			{
				filename: "invoice.pdf",
				mime_type: "application/pdf",
				size_bytes: 128,
			},
		]);
	});

	it("keeps existing mirrored message content when the raw source is unchanged", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing-unchanged",
			syncEnabled: 1,
		});
		await insertSyncState("acct-existing-unchanged", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 7,
			backfill_next_uid: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-existing-unchanged",
				account_id: "acct-existing-unchanged",
				message_id: "<msg-existing-unchanged@example.com>",
				thread_key: "thread-existing-unchanged",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Sender",
				sender_address: "sender@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Stable subject",
				in_reply_to: null,
				body_text_primary: "stable body",
				body_text_forwarded: "",
				body_text_normalized: "stable body",
				snippet: "stable body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "stable-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-existing-unchanged",
				message_id: "msg-existing-unchanged",
				account_id: "acct-existing-unchanged",
				remote_message_id: "gm-existing-unchanged",
				remote_thread_id: "thr-existing-unchanged",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 5,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/stable.eml",
				raw_sha256: "stable-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const parseRawMessage = vi.fn();
		const writeRawEml = vi.fn();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				{
					uid: 6,
					gmMsgId: "gm-existing-unchanged",
					gmThrid: "thr-existing-unchanged",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("stable raw"),
					sha256: "stable-sha",
				},
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 7,
				messageCount: 1,
			})),
			parseRawMessage,
			writeRawEml,
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runDeltaSync("acct-existing-unchanged");

		expect(parseRawMessage).not.toHaveBeenCalled();
		expect(writeRawEml).not.toHaveBeenCalled();

		const message = await db
			.selectFrom("messages")
			.select(["subject", "content_sha256"])
			.where("id", "=", "msg-existing-unchanged")
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			subject: "Stable subject",
			content_sha256: "stable-sha",
		});
		const source = await db
			.selectFrom("message_sources")
			.select(["imap_uid", "raw_rfc822_path", "raw_sha256", "state"])
			.where("id", "=", "src-existing-unchanged")
			.executeTakeFirstOrThrow();
		expect(source).toEqual({
			imap_uid: 6,
			raw_rfc822_path: "/tmp/stable.eml",
			raw_sha256: "stable-sha",
			state: "active",
		});
	});

	it("moves a message to a new conversation when the raw source is unchanged but the thread changes", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-thread-move",
			syncEnabled: 1,
		});
		await insertSyncState("acct-thread-move", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 7,
			backfill_next_uid: null,
		});
		const oldConversationId = await insertConversationRow(db, {
			id: "conv-thread-old",
			accountId: "acct-thread-move",
			gmailThreadId: "thr-thread-old",
			messageCount: 1,
			firstMessageReceivedAt: "2026-01-01T00:00:00.000Z",
			lastMessageReceivedAt: "2026-01-01T00:00:00.000Z",
		});
		const newConversationId = await insertConversationRow(db, {
			id: "conv-thread-new",
			accountId: "acct-thread-move",
			gmailThreadId: "thr-thread-new",
			messageCount: 0,
			firstMessageReceivedAt: null,
			lastMessageReceivedAt: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-thread-move",
				account_id: "acct-thread-move",
				message_id: "<msg-thread-move@example.com>",
				thread_key: "thread-thread-move",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: oldConversationId,
				sender_name: "Sender",
				sender_address: "sender@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Stable subject",
				in_reply_to: null,
				body_text_primary: "stable body",
				body_text_forwarded: "",
				body_text_normalized: "stable body",
				snippet: "stable body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "stable-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-thread-move",
				message_id: "msg-thread-move",
				account_id: "acct-thread-move",
				remote_message_id: "gm-thread-move",
				remote_thread_id: "thr-thread-old",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 5,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/thread-move.eml",
				raw_sha256: "stable-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const parseRawMessage = vi.fn();
		const writeRawEml = vi.fn();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				{
					uid: 6,
					gmMsgId: "gm-thread-move",
					gmThrid: "thr-thread-new",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("stable raw"),
					sha256: "stable-sha",
				},
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 7,
				messageCount: 1,
			})),
			parseRawMessage,
			writeRawEml,
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runDeltaSync("acct-thread-move");

		expect(parseRawMessage).not.toHaveBeenCalled();
		expect(writeRawEml).not.toHaveBeenCalled();

		const message = await db
			.selectFrom("messages")
			.select(["conversation_id", "ingested_at"])
			.where("id", "=", "msg-thread-move")
			.executeTakeFirstOrThrow();
		expect(message.ingested_at).toBe("2026-01-01T00:00:00.000Z");
		expect(message.conversation_id).not.toBe(oldConversationId);

		const source = await db
			.selectFrom("message_sources")
			.select(["remote_thread_id"])
			.where("id", "=", "src-thread-move")
			.executeTakeFirstOrThrow();
		expect(source.remote_thread_id).toBe("thr-thread-new");

		expect(
			await db
				.selectFrom("conversations")
				.select(["id"])
				.where("id", "=", oldConversationId)
				.executeTakeFirst(),
		).toBeUndefined();

		const newConversation = await db
			.selectFrom("conversations")
			.select([
				"id",
				"gmail_thread_id",
				"message_count",
				"first_message_received_at",
				"last_message_received_at",
			])
			.where("account_id", "=", "acct-thread-move")
			.where("gmail_thread_id", "=", "thr-thread-new")
			.executeTakeFirstOrThrow();
		expect(newConversation.id).toBe(newConversationId);
		expect(newConversation.id).toBe(message.conversation_id);
		expect(newConversation.message_count).toBe(1);
		expect(newConversation.first_message_received_at).toBe(
			"2026-01-01T00:00:00.000Z",
		);
		expect(newConversation.last_message_received_at).toBe(
			"2026-01-01T00:00:00.000Z",
		);
	});

	it("leaves conversation linkage null when Gmail does not provide a thread id", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-no-thread",
			syncEnabled: 1,
		});
		await insertSyncState("acct-no-thread", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 1,
			backfill_next_uid: null,
		});

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				{
					uid: 1,
					gmMsgId: "gm-no-thread",
					gmThrid: "",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("raw"),
					sha256: "sha-no-thread",
				},
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, `content-${sha}`),
			),
			writeRawEml: vi.fn(() => "/tmp/no-thread.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runDeltaSync("acct-no-thread");

		const message = await db
			.selectFrom("messages")
			.select(["conversation_id"])
			.where("account_id", "=", "acct-no-thread")
			.executeTakeFirstOrThrow();
		expect(message.conversation_id).toBeNull();
		expect(
			await db.selectFrom("conversations").select(["id"]).execute(),
		).toEqual([]);
	});

	it("keeps the fast path when the raw hash is unchanged and both thread ids are empty", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-empty-thread-fast-path",
			syncEnabled: 1,
		});
		await insertSyncState("acct-empty-thread-fast-path", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 1,
			backfill_next_uid: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-empty-thread-fast-path",
				account_id: "acct-empty-thread-fast-path",
				message_id: "<msg-empty-thread-fast-path@example.com>",
				thread_key: "thread-empty-thread-fast-path",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Sender",
				sender_address: "sender@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Stable subject",
				in_reply_to: null,
				body_text_primary: "stable body",
				body_text_forwarded: "",
				body_text_normalized: "stable body",
				snippet: "stable body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "stable-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-empty-thread-fast-path",
				message_id: "msg-empty-thread-fast-path",
				account_id: "acct-empty-thread-fast-path",
				remote_message_id: "gm-empty-thread-fast-path",
				remote_thread_id: null,
				mailbox: "[Gmail]/All Mail",
				imap_uid: 5,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/empty-thread-fast-path.eml",
				raw_sha256: "stable-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const parseRawMessage = vi.fn();
		const writeRawEml = vi.fn();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				{
					uid: 6,
					gmMsgId: "gm-empty-thread-fast-path",
					gmThrid: "",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("stable raw"),
					sha256: "stable-sha",
				},
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 7,
				messageCount: 1,
			})),
			parseRawMessage,
			writeRawEml,
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runDeltaSync("acct-empty-thread-fast-path");

		expect(parseRawMessage).not.toHaveBeenCalled();
		expect(writeRawEml).not.toHaveBeenCalled();
		const source = await db
			.selectFrom("message_sources")
			.select(["remote_thread_id", "imap_uid"])
			.where("id", "=", "src-empty-thread-fast-path")
			.executeTakeFirstOrThrow();
		expect(source).toEqual({
			remote_thread_id: null,
			imap_uid: 6,
		});
	});

	it("rolls back refreshed message writes when attachment replacement fails", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing-rollback",
			syncEnabled: 1,
		});
		await insertSyncState("acct-existing-rollback", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 1,
			backfill_next_uid: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-existing-rollback",
				account_id: "acct-existing-rollback",
				message_id: "<msg-existing-rollback@example.com>",
				thread_key: "thread-existing-rollback",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Old Sender",
				sender_address: "old@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Old subject",
				in_reply_to: null,
				body_text_primary: "old body",
				body_text_forwarded: "",
				body_text_normalized: "old body",
				snippet: "old body",
				attachment_count: 1,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "old-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("attachments")
			.values({
				id: "att-existing-rollback",
				message_id: "msg-existing-rollback",
				filename: "old.pdf",
				mime_type: "application/pdf",
				size_bytes: 64,
				content_id: null,
				is_inline: 0,
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-existing-rollback",
				message_id: "msg-existing-rollback",
				account_id: "acct-existing-rollback",
				remote_message_id: "gm-existing-rollback",
				remote_thread_id: "thr-existing-rollback",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/old-rollback.eml",
				raw_sha256: "old-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				{
					uid: 1,
					gmMsgId: "gm-existing-rollback",
					gmThrid: "thr-existing-rollback",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("new raw"),
					sha256: "new-sha",
				},
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(async () => ({
				id: "ignored-id",
				messageId: "<msg-existing-rollback@example.com>",
				threadKey: "thread-existing-rollback",
				receivedAt: null,
				senderName: "New Sender",
				senderAddress: "new@example.com",
				toJson: "[]",
				ccJson: "[]",
				subject: "New subject",
				inReplyTo: null,
				bodyTextPrimary: "new body",
				bodyTextForwarded: "",
				bodyTextNormalized: "new body",
				snippet: "new body",
				attachmentCount: 2,
				hasHtml: 0,
				parseStatus: "parsed",
				bodyExtractionStrategy: "plain_text",
				parseErrorReason: null,
				tokenEstimate: 2,
				contentSha256: "new-sha",
				attachments: [
					{
						id: "att-dup",
						filename: "invoice-a.pdf",
						mimeType: "application/pdf",
						sizeBytes: 128,
						contentId: null,
						isInline: 0,
					},
					{
						id: "att-dup",
						filename: "invoice-b.pdf",
						mimeType: "application/pdf",
						sizeBytes: 256,
						contentId: null,
						isInline: 0,
					},
				],
			})),
			writeRawEml: vi.fn(() => "/tmp/new-rollback.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(sync.runDeltaSync("acct-existing-rollback")).rejects.toThrow();

		const message = await db
			.selectFrom("messages")
			.select(["subject", "sender_address", "content_sha256"])
			.where("id", "=", "msg-existing-rollback")
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			subject: "Old subject",
			sender_address: "old@example.com",
			content_sha256: "old-sha",
		});
		const source = await db
			.selectFrom("message_sources")
			.select([
				"raw_sha256",
				"raw_rfc822_path",
				"imap_uid",
				"last_seen_at",
				"updated_at",
			])
			.where("id", "=", "src-existing-rollback")
			.executeTakeFirstOrThrow();
		expect(source).toEqual({
			raw_sha256: "old-sha",
			raw_rfc822_path: "/tmp/old-rollback.eml",
			imap_uid: 1,
			last_seen_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		const attachments = await db
			.selectFrom("attachments")
			.select(["id", "filename"])
			.where("message_id", "=", "msg-existing-rollback")
			.execute();
		expect(attachments).toEqual([
			{
				id: "att-existing-rollback",
				filename: "old.pdf",
			},
		]);
	});

	it("logs parse errors when an existing mirrored message is refreshed with malformed raw content", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const log = createMockLogModule();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing-parse-error",
			syncEnabled: 1,
		});
		await insertSyncState("acct-existing-parse-error", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 1,
			backfill_next_uid: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-existing-parse-error",
				account_id: "acct-existing-parse-error",
				message_id: "<msg-existing-parse-error@example.com>",
				thread_key: "thread-existing-parse-error",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Sender",
				sender_address: "sender@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Subject",
				in_reply_to: null,
				body_text_primary: "body",
				body_text_forwarded: "",
				body_text_normalized: "body",
				snippet: "body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "old-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-existing-parse-error",
				message_id: "msg-existing-parse-error",
				account_id: "acct-existing-parse-error",
				remote_message_id: "gm-existing-parse-error",
				remote_thread_id: "thr-existing-parse-error",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/old-parse-error.eml",
				raw_sha256: "old-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/log", () => log.module);
		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			fetchMessageRange: async () => [
				{
					uid: 1,
					gmMsgId: "gm-existing-parse-error",
					gmThrid: "thr-existing-parse-error",
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					raw: Buffer.from("new raw"),
					sha256: "new-sha",
				},
			],
			getMailboxStatus: async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			}),
			parseRawMessage: async () => ({
				id: "ignored-id",
				messageId: "<msg-existing-parse-error@example.com>",
				threadKey: "thread-existing-parse-error",
				receivedAt: "2026-01-02T00:00:00.000Z",
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
				parseErrorReason: "parse failure",
				tokenEstimate: 0,
				contentSha256: "new-sha",
				attachments: [],
			}),
			writeRawEml: () => "/tmp/new-parse-error.eml",
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runDeltaSync("acct-existing-parse-error");

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "sync.message.parse_error",
				}),
			]),
		);
	});

	it("reconcile accepts x-gm-msgid fallbacks and ignores messages with no Gmail id", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconcile-gm-fallback",
			syncEnabled: 1,
		});
		await insertSyncState("acct-reconcile-gm-fallback", {
			latest_uid_cursor: 1,
			earliest_uid_cursor: 1,
			backfill_next_uid: null,
		});

		const client = {
			connect: vi.fn(async () => undefined),
			getMailboxLock: vi.fn(async () => ({
				release: vi.fn(),
			})),
			logout: vi.fn(async () => undefined),
			fetch: async function* () {
				yield {
					"x-gm-msgid": "gm-fallback",
				};
				yield {};
			},
		};

		mockFreshToken("access-token");
		mockQueueJobIdempotent();
		mockImap({
			client: client as ReturnType<typeof createMockClient>,
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.runReconcile("acct-reconcile-gm-fallback"),
		).resolves.toEqual({
			skipped: false,
			tombstoned: 0,
		});
	});

	it("emits bootstrap log events with the new namespace", async () => {
		const runtime = await createTestRuntime();
		process.env.ZMAIL_IMAP_FETCH_WINDOW = "2";
		vi.resetModules();
		const log = createMockLogModule();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-log",
			syncEnabled: 1,
		});

		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => "job-backfill"),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [
				createFetchedMessage(1),
				createFetchedMessage(2),
			]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 55,
				uidNext: 3,
				messageCount: 2,
			})),
			parseRawMessage: vi.fn(async (_raw: Buffer, sha: string) =>
				createParsedMessage(`msg-${sha}`, sha),
			),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runFullSync("acct-log");

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "sync.bootstrap.start",
				}),
				expect.objectContaining({
					type: "complete",
					event: "sync.bootstrap.complete",
				}),
			]),
		);
	});

	it("logs parse errors when bootstrap ingests a newly inserted malformed message", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const log = createMockLogModule();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-parse-error",
			syncEnabled: 1,
		});

		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [createFetchedMessage(1)]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 55,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(async () => ({
				id: "msg-parse-error",
				messageId: "<parse-error@example.com>",
				threadKey: "thread-parse-error",
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
				parseErrorReason: "parse failure",
				tokenEstimate: 0,
				contentSha256: "sha-1",
				attachments: [],
			})),
			writeRawEml: vi.fn(() => "/tmp/raw.eml"),
		}));

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await sync.runFullSync("acct-parse-error");

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "sync.message.parse_error",
				}),
			]),
		);
		const message = await db
			.selectFrom("messages")
			.select(["parse_status"])
			.where("account_id", "=", "acct-parse-error")
			.executeTakeFirstOrThrow();
		expect(message.parse_status).toBe("error");
	});

	it("rolls back newly inserted message rows when source insertion fails", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-insert-rollback",
			syncEnabled: 1,
		});
		await insertSyncState("acct-insert-rollback", {
			uidvalidity: 100,
			latest_uid_cursor: 0,
			earliest_uid_cursor: 1,
			backfill_snapshot_uid: 1,
			backfill_next_uid: null,
		});
		await db
			.insertInto("messages")
			.values({
				id: "msg-existing-source-conflict",
				account_id: "acct-insert-rollback",
				message_id: "<existing-source-conflict@example.com>",
				thread_key: "thread-existing-source-conflict",
				received_at: "2026-01-01T00:00:00.000Z",
				ingested_at: "2026-01-01T00:00:00.000Z",
				conversation_id: null,
				sender_name: "Existing",
				sender_address: "existing@example.com",
				to_json: "[]",
				cc_json: "[]",
				subject: "Existing subject",
				in_reply_to: null,
				body_text_primary: "body",
				body_text_forwarded: "",
				body_text_normalized: "body",
				snippet: "body",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 3,
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 1,
				content_sha256: "existing-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-duplicate",
				message_id: "msg-existing-source-conflict",
				account_id: "acct-insert-rollback",
				remote_message_id: "gm-existing-source-conflict",
				remote_thread_id: "thr-existing-source-conflict",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 99,
				uidvalidity: 100,
				raw_rfc822_path: "/tmp/existing-source-conflict.eml",
				raw_sha256: "existing-sha",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		vi.doMock("node:crypto", async () => {
			const actual =
				await vi.importActual<typeof import("node:crypto")>("node:crypto");
			return {
				...actual,
				randomUUID: vi.fn(() => "src-duplicate"),
			};
		});
		vi.doMock("#/lib/google-oauth", () => ({
			ensureFreshToken: vi.fn(async () => ({
				accessToken: "access-token",
			})),
		}));
		vi.doMock("#/lib/jobs", () => ({
			queueJobIdempotent: vi.fn(async () => null),
		}));
		vi.doMock("#/lib/imap", () => ({
			createImapClient: vi.fn(() => createMockClient()),
			fetchMessageRange: vi.fn(async () => [createFetchedMessage(1)]),
			fetchMessageWindowDescending: vi.fn(),
			getMailboxStatus: vi.fn(async () => ({
				uidvalidity: 100,
				uidNext: 2,
				messageCount: 1,
			})),
			parseRawMessage: vi.fn(async () => ({
				id: "msg-insert-rollback",
				messageId: "<msg-insert-rollback@example.com>",
				threadKey: "thread-insert-rollback",
				receivedAt: "2026-01-01T00:00:00.000Z",
				senderName: "Sender",
				senderAddress: "sender@example.com",
				toJson: "[]",
				ccJson: "[]",
				subject: "Subject rollback",
				inReplyTo: null,
				bodyTextPrimary: "body",
				bodyTextForwarded: "",
				bodyTextNormalized: "body",
				snippet: "body",
				attachmentCount: 1,
				hasHtml: 0,
				parseStatus: "parsed",
				bodyExtractionStrategy: "plain_text",
				parseErrorReason: null,
				tokenEstimate: 1,
				contentSha256: "sha-1",
				attachments: [
					{
						id: "att-insert-rollback",
						filename: "invoice.pdf",
						mimeType: "application/pdf",
						sizeBytes: 128,
						contentId: null,
						isInline: 0,
					},
				],
			})),
			writeRawEml: vi.fn(() => "/tmp/insert-rollback.eml"),
		}));

		try {
			const sync =
				await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
			await expect(sync.runDeltaSync("acct-insert-rollback")).rejects.toThrow();
		} finally {
			vi.doUnmock("node:crypto");
		}

		expect(
			await db
				.selectFrom("messages")
				.select(["id"])
				.where("id", "=", "msg-insert-rollback")
				.executeTakeFirst(),
		).toBeUndefined();
		expect(
			await db
				.selectFrom("attachments")
				.select(["id"])
				.where("message_id", "=", "msg-insert-rollback")
				.execute(),
		).toEqual([]);
		expect(
			await db
				.selectFrom("message_sources")
				.select(["remote_message_id"])
				.where("remote_message_id", "=", "gm-1")
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("reextracts a stored parse-error message from raw RFC822 and preserves ingest timestamps", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const rawPath = join(rawDir, "gm-reextract.eml");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(
			rawPath,
			[
				"From: Billing <billing@example.com>",
				"To: acct-1@example.com",
				"Message-ID: <gm-reextract@example.com>",
				"Subject: Recovered receipt",
				"",
				"Recovered body",
				"",
			].join("\n"),
		);

		await db
			.insertInto("messages")
			.values({
				id: "msg-reextract",
				account_id: "acct-1",
				message_id: "<parse-error@example.com>",
				thread_key: "thread-parse-error",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "old-content-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-reextract",
				message_id: "msg-reextract",
				account_id: "acct-1",
				remote_message_id: "gm-reextract",
				remote_thread_id: "thr-reextract",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: rawPath,
				raw_sha256: "old-raw-sha",
				state: "active",
				first_seen_at: "2026-01-02T00:00:00.000Z",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doUnmock("#/lib/imap");
		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.reextractStoredParseErrorMessage({
			messageId: "msg-reextract",
		});

		expect(result).toMatchObject({
			outcome: "recovered",
			accountId: "acct-1",
			messageId: "msg-reextract",
			createdAt: "2026-01-01T00:00:00.000Z",
			ingestedAt: "2026-01-03T00:00:00.000Z",
		});

		const message = await db
			.selectFrom("messages")
			.select([
				"message_id",
				"subject",
				"sender_address",
				"body_text_primary",
				"body_text_normalized",
				"parse_status",
				"parse_error_reason",
				"received_at",
				"created_at",
				"ingested_at",
				"conversation_id",
			])
			.where("id", "=", "msg-reextract")
			.executeTakeFirstOrThrow();
		expect(message).toMatchObject({
			message_id: "<gm-reextract@example.com>",
			subject: "Recovered receipt",
			sender_address: "billing@example.com",
			body_text_primary: "Recovered body",
			body_text_normalized: "Recovered body",
			parse_status: "parsed",
			parse_error_reason: null,
			received_at: "2026-01-02T00:00:00.000Z",
			created_at: "2026-01-01T00:00:00.000Z",
			ingested_at: "2026-01-03T00:00:00.000Z",
		});
		expect(message.conversation_id).toBeTruthy();

		const source = await db
			.selectFrom("message_sources")
			.select(["raw_rfc822_path", "raw_sha256"])
			.where("id", "=", "src-reextract")
			.executeTakeFirstOrThrow();
		expect(source.raw_rfc822_path).toBe(rawPath);
		expect(source.raw_sha256).not.toBe("old-raw-sha");
	});

	it("preserves the stored raw sha when reparsing the same raw bytes", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const rawPath = join(rawDir, "gm-stable-raw-sha.eml");
		const raw = Buffer.from(
			[
				"From: Stable <stable@example.com>",
				"To: acct-1@example.com",
				"Message-ID: <gm-stable-raw-sha@example.com>",
				"Subject: Stable raw sha",
				"",
				"Stable body",
				"",
			].join("\n"),
		);
		const rawSha256 = createHash("sha256").update(raw).digest("hex");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(rawPath, raw);

		await db
			.insertInto("messages")
			.values({
				id: "msg-stable-raw-sha",
				account_id: "acct-1",
				message_id: "<msg-stable-raw-sha@example.com>",
				thread_key: "thread-stable-raw-sha",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "stable-raw-content-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-stable-raw-sha",
				message_id: "msg-stable-raw-sha",
				account_id: "acct-1",
				remote_message_id: "gm-stable-raw-sha",
				remote_thread_id: "thr-stable-raw-sha",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: rawPath,
				raw_sha256: rawSha256,
				state: "active",
				first_seen_at: "2026-01-02T00:00:00.000Z",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doUnmock("#/lib/imap");
		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.reextractStoredParseErrorMessage({
			messageId: "msg-stable-raw-sha",
		});

		expect(result.outcome).toBe("recovered");
		const source = await db
			.selectFrom("message_sources")
			.select(["raw_sha256"])
			.where("id", "=", "src-stable-raw-sha")
			.executeTakeFirstOrThrow();
		expect(source.raw_sha256).toBe(rawSha256);
	});

	it("reports missing raw files without mutating the message row", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("messages")
			.values({
				id: "msg-missing-raw",
				account_id: "acct-1",
				message_id: "<msg-missing-raw@example.com>",
				thread_key: "thread-missing-raw",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "missing-raw-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-missing-raw",
				message_id: "msg-missing-raw",
				account_id: "acct-1",
				remote_message_id: "gm-missing-raw",
				remote_thread_id: "thr-missing-raw",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: join(runtime.dataDir, "missing.eml"),
				raw_sha256: "missing-raw-sha",
				state: "active",
				first_seen_at: "2026-01-02T00:00:00.000Z",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doUnmock("#/lib/imap");
		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.reextractStoredParseErrorMessage({
			messageId: "msg-missing-raw",
		});

		expect(result.outcome).toBe("missingRaw");
		const message = await db
			.selectFrom("messages")
			.select(["parse_status", "parse_error_reason", "content_sha256"])
			.where("id", "=", "msg-missing-raw")
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			parse_status: "error",
			parse_error_reason: "input.html?.trim is not a function",
			content_sha256: "missing-raw-sha",
		});
	});

	it("prefers active and newest source rows when reparsing stored messages", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const olderRawPath = join(rawDir, "older.eml");
		const preferredRawPath = join(rawDir, "preferred.eml");
		const tombstonedRawPath = join(rawDir, "tombstoned.eml");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(
			olderRawPath,
			[
				"From: Older <older@example.com>",
				"Message-ID: <older@example.com>",
				"Subject: Older source",
				"",
				"Older body",
			].join("\n"),
		);
		writeFileSync(
			preferredRawPath,
			[
				"From: Preferred <preferred@example.com>",
				"Message-ID: <preferred@example.com>",
				"Subject: Preferred source",
				"",
				"Preferred body",
			].join("\n"),
		);
		writeFileSync(
			tombstonedRawPath,
			[
				"From: Tombstoned <tombstoned@example.com>",
				"Message-ID: <tombstoned@example.com>",
				"Subject: Tombstoned source",
				"",
				"Tombstoned body",
			].join("\n"),
		);

		await db
			.insertInto("messages")
			.values({
				id: "msg-preferred-source",
				account_id: "acct-1",
				message_id: "<msg-preferred-source@example.com>",
				thread_key: "thread-preferred-source",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "preferred-source-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values([
				{
					id: "src-preferred-older",
					message_id: "msg-preferred-source",
					account_id: "acct-1",
					remote_message_id: "gm-preferred-source-older",
					remote_thread_id: "thr-preferred-source",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 1,
					uidvalidity: 100,
					raw_rfc822_path: olderRawPath,
					raw_sha256: "older-sha",
					state: "active",
					first_seen_at: "2026-01-01T00:00:00.000Z",
					last_seen_at: "2026-01-01T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "src-preferred-newest",
					message_id: "msg-preferred-source",
					account_id: "acct-1",
					remote_message_id: "gm-preferred-source-newest",
					remote_thread_id: "thr-preferred-source",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 2,
					uidvalidity: 100,
					raw_rfc822_path: preferredRawPath,
					raw_sha256: "preferred-sha",
					state: "active",
					first_seen_at: "2026-01-02T00:00:00.000Z",
					last_seen_at: "2026-01-02T00:00:00.000Z",
					tombstoned_at: null,
					updated_at: "2026-01-02T00:00:00.000Z",
				},
				{
					id: "src-preferred-tombstoned",
					message_id: "msg-preferred-source",
					account_id: "acct-1",
					remote_message_id: "gm-preferred-source-tombstoned",
					remote_thread_id: "thr-preferred-source",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 3,
					uidvalidity: 100,
					raw_rfc822_path: tombstonedRawPath,
					raw_sha256: "tombstoned-sha",
					state: "tombstoned",
					first_seen_at: "2026-01-03T00:00:00.000Z",
					last_seen_at: "2026-01-03T00:00:00.000Z",
					tombstoned_at: "2026-01-03T00:00:00.000Z",
					updated_at: "2026-01-03T00:00:00.000Z",
				},
			])
			.execute();

		vi.doUnmock("#/lib/imap");
		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.reextractStoredParseErrorMessage({
			messageId: "msg-preferred-source",
		});

		expect(result.outcome).toBe("recovered");
		const message = await db
			.selectFrom("messages")
			.select(["subject", "sender_address", "body_text_primary"])
			.where("id", "=", "msg-preferred-source")
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			subject: "Preferred source",
			sender_address: "preferred@example.com",
			body_text_primary: "Preferred body",
		});
	});

	it("reports missing raw when the preferred source row has no RFC822 path", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await db
			.insertInto("messages")
			.values({
				id: "msg-missing-raw-path",
				account_id: "acct-1",
				message_id: "<msg-missing-raw-path@example.com>",
				thread_key: "thread-missing-raw-path",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "missing-raw-path-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-missing-raw-path",
				message_id: "msg-missing-raw-path",
				account_id: "acct-1",
				remote_message_id: "gm-missing-raw-path",
				remote_thread_id: "thr-missing-raw-path",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: null,
				raw_sha256: "missing-raw-path-sha",
				state: "active",
				first_seen_at: "2026-01-02T00:00:00.000Z",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doUnmock("#/lib/imap");
		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.reextractStoredParseErrorMessage({
			messageId: "msg-missing-raw-path",
		});

		expect(result.outcome).toBe("missingRaw");
	});

	it("rethrows unexpected raw read failures during parse-error re-extraction", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		mkdirSync(rawDir, { recursive: true });
		await db
			.insertInto("messages")
			.values({
				id: "msg-read-error",
				account_id: "acct-1",
				message_id: "<msg-read-error@example.com>",
				thread_key: "thread-read-error",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "read-error-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-read-error",
				message_id: "msg-read-error",
				account_id: "acct-1",
				remote_message_id: "gm-read-error",
				remote_thread_id: "thr-read-error",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: rawDir,
				raw_sha256: "read-error-sha",
				state: "active",
				first_seen_at: "2026-01-02T00:00:00.000Z",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doUnmock("#/lib/imap");
		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		await expect(
			sync.reextractStoredParseErrorMessage({
				messageId: "msg-read-error",
			}),
		).rejects.toThrow();
	});

	it("reports still-failing reparses without mutating the message row", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rawDir = join(runtime.dataDir, "accounts", "acct-1", "raw");
		const rawPath = join(rawDir, "gm-still-failing.eml");
		mkdirSync(rawDir, { recursive: true });
		writeFileSync(rawPath, "raw");
		await db
			.insertInto("messages")
			.values({
				id: "msg-still-failing",
				account_id: "acct-1",
				message_id: "<msg-still-failing@example.com>",
				thread_key: "thread-still-failing",
				received_at: "2026-01-02T00:00:00.000Z",
				ingested_at: "2026-01-03T00:00:00.000Z",
				conversation_id: null,
				sender_name: null,
				sender_address: null,
				to_json: "[]",
				cc_json: "[]",
				subject: null,
				in_reply_to: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				snippet: "",
				attachment_count: 0,
				has_html: 0,
				raw_byte_start: 0,
				raw_byte_end: 0,
				parse_status: "error",
				body_extraction_strategy: "parse_error",
				parse_error_reason: "input.html?.trim is not a function",
				token_estimate: 0,
				content_sha256: "still-failing-sha",
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_sources")
			.values({
				id: "src-still-failing",
				message_id: "msg-still-failing",
				account_id: "acct-1",
				remote_message_id: "gm-still-failing",
				remote_thread_id: "thr-still-failing",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 1,
				uidvalidity: 100,
				raw_rfc822_path: rawPath,
				raw_sha256: "still-failing-sha",
				state: "active",
				first_seen_at: "2026-01-02T00:00:00.000Z",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/imap", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/imap")>("#/lib/imap");
			return {
				...actual,
				parseRawMessage: vi.fn(async () => ({
					id: "msg-still-failing-new",
					messageId: "<msg-still-failing-new@example.com>",
					threadKey: "thread-still-failing-new",
					receivedAt: "2026-01-02T00:00:00.000Z",
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
					parseErrorReason: "still broken",
					tokenEstimate: 0,
					contentSha256: "still-failing-new-sha",
					attachments: [],
				})),
			};
		});

		const sync =
			await runtime.importFresh<typeof import("#/lib/sync")>("#/lib/sync");
		const result = await sync.reextractStoredParseErrorMessage({
			messageId: "msg-still-failing",
		});

		expect(result).toMatchObject({
			outcome: "stillFailing",
			parseErrorReason: "still broken",
		});
		const message = await db
			.selectFrom("messages")
			.select(["parse_status", "parse_error_reason", "content_sha256"])
			.where("id", "=", "msg-still-failing")
			.executeTakeFirstOrThrow();
		expect(message).toEqual({
			parse_status: "error",
			parse_error_reason: "input.html?.trim is not a function",
			content_sha256: "still-failing-sha",
		});
	});
});
