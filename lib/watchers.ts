import type { ImapFlow } from "imapflow";
import { APP_CONFIG, nowIso } from "#/lib/config";
import { getDb } from "#/lib/db";
import { ensureFreshToken } from "#/lib/google-oauth";
import { createImapClient } from "#/lib/imap";
import { queueJobIdempotent } from "#/lib/jobs";
import { type LogTrace, startTrace } from "#/lib/log";

interface AccountWatcher {
	accountId: string;
	client: ImapFlow | null;
	lock: { release: () => void } | null;
	pollTimer: ReturnType<typeof setInterval> | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	reconcileTimer: ReturnType<typeof setInterval> | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	running: boolean;
}

const watchers = new Map<string, AccountWatcher>();

export function getWatcherStatus(accountId: string) {
	return watchers.get(accountId)?.running ? "running" : "stopped";
}

export function getActiveWatcherCount() {
	let count = 0;
	for (const watcher of watchers.values()) {
		if (watcher.running) {
			count += 1;
		}
	}
	return count;
}

export async function startWatcher(accountId: string, trace?: LogTrace) {
	if (watchers.get(accountId)?.running) {
		return;
	}

	const watcherTrace =
		trace?.child({
			kind: "watcher",
			operation: "start_watcher",
			account_id: accountId,
		}) ??
		startTrace({
			kind: "watcher",
			operation: "start_watcher",
			account_id: accountId,
		});
	watcherTrace.info("watcher.start");

	const watcher: AccountWatcher = {
		accountId,
		client: null,
		lock: null,
		pollTimer: null,
		idleTimer: null,
		reconcileTimer: null,
		reconnectTimer: null,
		running: true,
	};
	watchers.set(accountId, watcher);

	await updateWatcherStatus(accountId, "connecting");

	try {
		await connectAndWatch(watcher, watcherTrace);
	} catch (error) {
		await handleWatcherError(watcher, error, watcherTrace);
	}
}

export async function stopWatcher(accountId: string) {
	const watcherTrace = startTrace({
		kind: "watcher",
		operation: "stop_watcher",
		account_id: accountId,
	});
	const watcher = watchers.get(accountId);
	if (!watcher) {
		return;
	}

	watcher.running = false;
	if (watcher.pollTimer) {
		clearInterval(watcher.pollTimer);
		watcher.pollTimer = null;
	}
	if (watcher.idleTimer) {
		clearInterval(watcher.idleTimer);
		watcher.idleTimer = null;
	}
	if (watcher.reconcileTimer) {
		clearInterval(watcher.reconcileTimer);
		watcher.reconcileTimer = null;
	}
	if (watcher.reconnectTimer) {
		clearTimeout(watcher.reconnectTimer);
		watcher.reconnectTimer = null;
	}
	if (watcher.lock) {
		try {
			watcher.lock.release();
		} catch {
			// ignore
		}
		watcher.lock = null;
	}
	if (watcher.client) {
		try {
			await watcher.client.logout();
		} catch {
			// ignore
		}
		watcher.client = null;
	}
	watchers.delete(accountId);
	await updateWatcherStatus(accountId, "stopped");
	watcherTrace.complete("watcher.stopped", {
		watcher_status: "stopped",
	});
}

export async function stopAllWatchers() {
	const ids = [...watchers.keys()];
	for (const id of ids) {
		await stopWatcher(id);
	}
}

async function connectAndWatch(watcher: AccountWatcher, trace?: LogTrace) {
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", watcher.accountId)
		.executeTakeFirstOrThrow();
	trace?.add({
		mailbox: account.selected_mailbox,
	});

	const token = await ensureFreshToken(watcher.accountId);
	if (!token) {
		await db
			.updateTable("accounts")
			.set({ sync_status: "needs_reconnect", updated_at: nowIso() })
			.where("id", "=", watcher.accountId)
			.execute();
		watcher.running = false;
		await updateWatcherStatus(watcher.accountId, "error");
		trace?.fail(
			"watcher.error",
			new Error("No valid OAuth token for account"),
			{
				watcher_status: "error",
			},
		);
		return;
	}

	const client = createImapClient({
		email: account.email_address,
		accessToken: token.accessToken,
	});

	watcher.client = client;

	await client.connect();
	watcher.lock = await client.getMailboxLock(account.selected_mailbox);
	await updateWatcherStatus(watcher.accountId, "idle");

	const now = nowIso();
	await db
		.updateTable("account_sync_state")
		.set({ last_idle_started_at: now, updated_at: now })
		.where("account_id", "=", watcher.accountId)
		.execute();
	trace?.complete("watcher.connected", {
		watcher_status: "idle",
	});

	// Listen for new messages
	client.on("exists", () => {
		void enqueueDeltaSync(watcher.accountId, "exists");
	});

	client.on("close", () => {
		startTrace({
			kind: "watcher",
			operation: "watcher_close",
			account_id: watcher.accountId,
		}).info("watcher.closed", {
			outcome: "disconnected",
		});
		if (watcher.running) {
			void reconnectWatcher(watcher);
		}
	});

	// IDLE renewal timer (every 10 minutes per spec)
	watcher.idleTimer = setInterval(async () => {
		try {
			const db = getDb();
			await db
				.updateTable("account_sync_state")
				.set({ last_idle_heartbeat_at: nowIso(), updated_at: nowIso() })
				.where("account_id", "=", watcher.accountId)
				.execute();
			/* c8 ignore next 3 */
		} catch {
			// ignore heartbeat errors
		}
	}, APP_CONFIG.imapMaxIdleMs);

	// Poll fallback timer (every 5 minutes per spec)
	watcher.pollTimer = setInterval(() => {
		void enqueueDeltaSync(watcher.accountId, "poll");
	}, APP_CONFIG.imapPollMs);

	watcher.reconcileTimer = setInterval(() => {
		void enqueueReconcile(watcher.accountId);
	}, APP_CONFIG.syncReconcileMs);

	// Reset failures on successful connection
	await db
		.updateTable("account_sync_state")
		.set({ consecutive_failures: 0, backoff_until: null, updated_at: nowIso() })
		.where("account_id", "=", watcher.accountId)
		.execute();
}

async function reconnectWatcher(watcher: AccountWatcher) {
	/* c8 ignore next 3 */
	if (!watcher.running) {
		return;
	}

	if (watcher.pollTimer) {
		clearInterval(watcher.pollTimer);
		watcher.pollTimer = null;
	}
	if (watcher.idleTimer) {
		clearInterval(watcher.idleTimer);
		watcher.idleTimer = null;
	}
	if (watcher.reconcileTimer) {
		clearInterval(watcher.reconcileTimer);
		watcher.reconcileTimer = null;
	}
	if (watcher.lock) {
		try {
			watcher.lock.release();
			/* c8 ignore next 3 */
		} catch {
			// ignore
		}
		watcher.lock = null;
	}
	if (watcher.client) {
		try {
			await watcher.client.logout();
			/* c8 ignore next 3 */
		} catch {
			// ignore
		}
		watcher.client = null;
	}

	await updateWatcherStatus(watcher.accountId, "connecting");

	try {
		await connectAndWatch(
			watcher,
			startTrace({
				kind: "watcher",
				operation: "reconnect_watcher",
				account_id: watcher.accountId,
			}),
		);
	} catch (error) {
		await handleWatcherError(watcher, error);
	}
}

async function handleWatcherError(
	watcher: AccountWatcher,
	error: unknown,
	trace?: LogTrace,
) {
	const watcherTrace =
		trace ??
		startTrace({
			kind: "watcher",
			operation: "handle_watcher_error",
			account_id: watcher.accountId,
		});
	const db = getDb();
	const syncState = await db
		.selectFrom("account_sync_state")
		.select("consecutive_failures")
		.where("account_id", "=", watcher.accountId)
		.executeTakeFirst();

	const failures = (syncState?.consecutive_failures ?? 0) + 1;
	const maxBackoffMs = 30 * 60 * 1000;
	const backoffMs = Math.min(1000 * 2 ** failures, maxBackoffMs);
	const backoffUntil = new Date(Date.now() + backoffMs).toISOString();

	await db
		.updateTable("account_sync_state")
		.set({
			consecutive_failures: failures,
			backoff_until: backoffUntil,
			watcher_status: "error",
			updated_at: nowIso(),
		})
		.where("account_id", "=", watcher.accountId)
		.execute();

	await db
		.updateTable("accounts")
		.set({
			last_error: error instanceof Error ? error.message : String(error),
			updated_at: nowIso(),
		})
		.where("id", "=", watcher.accountId)
		.execute();
	watcherTrace.fail("watcher.error", error, {
		watcher_status: "error",
	});

	// Schedule reconnect after backoff
	if (watcher.running) {
		watcherTrace.info("watcher.reconnect_scheduled", {
			backoff_ms: backoffMs,
			watcher_status: "error",
		});
		watcher.reconnectTimer = setTimeout(() => {
			watcher.reconnectTimer = null;
			if (watcher.running) {
				void reconnectWatcher(watcher);
			}
		}, backoffMs);
	}
}

async function enqueueDeltaSync(accountId: string, source: "exists" | "poll") {
	await queueJobIdempotent({
		kind: "sync_account_delta",
		scopeType: "account",
		scopeId: accountId,
	});
	startTrace({
		kind: "watcher",
		operation: "enqueue_delta_sync",
		account_id: accountId,
	}).complete(
		source === "exists" ? "watcher.exists_enqueued" : "watcher.poll_enqueued",
	);
}

async function enqueueReconcile(accountId: string) {
	await queueJobIdempotent({
		kind: "sync_account_reconcile",
		scopeType: "account",
		scopeId: accountId,
	});
	startTrace({
		kind: "watcher",
		operation: "enqueue_reconcile",
		account_id: accountId,
	}).complete("watcher.reconcile_enqueued");
}

async function updateWatcherStatus(accountId: string, status: string) {
	const db = getDb();
	try {
		await db
			.updateTable("account_sync_state")
			.set({ watcher_status: status, updated_at: nowIso() })
			.where("account_id", "=", accountId)
			.execute();
		/* c8 ignore next 3 */
	} catch {
		// ignore if sync state doesn't exist yet
	}
}

export async function restoreWatchers() {
	const db = getDb();
	const accounts = await db
		.selectFrom("accounts")
		.select("id")
		.where("sync_enabled", "=", 1)
		.where("provider_kind", "=", "gmail")
		.execute();

	for (const account of accounts) {
		await startWatcher(account.id);
	}
}
