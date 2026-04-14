import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import { APP_CONFIG, nowIso } from "#/lib/config";
import { type DB, getDb } from "#/lib/db";
import { ensureFreshToken } from "#/lib/google-oauth";
import {
	createImapClient,
	fetchMessageRange,
	fetchMessageWindowDescending,
	getMailboxStatus,
	parseRawMessage,
	writeRawEml,
} from "#/lib/imap";
import { queueJobIdempotent } from "#/lib/jobs";
import { type LogTrace, startTrace } from "#/lib/log";

function parsedMessageValues(
	parsed: Awaited<ReturnType<typeof parseRawMessage>>,
	rawLength: number,
	receivedAtFallback: string,
) {
	return {
		message_id: parsed.messageId,
		thread_key: parsed.threadKey,
		received_at: parsed.receivedAt ?? receivedAtFallback,
		sender_name: parsed.senderName,
		sender_address: parsed.senderAddress,
		to_json: parsed.toJson,
		cc_json: parsed.ccJson,
		subject: parsed.subject,
		in_reply_to: parsed.inReplyTo,
		body_text_normalized: parsed.bodyTextNormalized,
		snippet: parsed.snippet,
		attachment_count: parsed.attachmentCount,
		has_html: parsed.hasHtml,
		raw_byte_start: 0,
		raw_byte_end: rawLength,
		parse_status: parsed.parseStatus,
		token_estimate: parsed.tokenEstimate,
		content_sha256: parsed.contentSha256,
	};
}

type SyncExecutor = Kysely<DB> | Transaction<DB>;

async function replaceAttachments(
	executor: SyncExecutor,
	messageId: string,
	attachments: Awaited<ReturnType<typeof parseRawMessage>>["attachments"],
) {
	await executor
		.deleteFrom("attachments")
		.where("message_id", "=", messageId)
		.execute();

	for (const attachment of attachments) {
		await executor
			.insertInto("attachments")
			.values({
				id: attachment.id,
				message_id: messageId,
				filename: attachment.filename,
				mime_type: attachment.mimeType,
				size_bytes: attachment.sizeBytes,
				content_id: attachment.contentId,
				is_inline: attachment.isInline,
			})
			.execute();
	}
}

function activeSyncStatus(backfillNextUid: number | null) {
	return backfillNextUid !== null ? "backfilling" : "idle";
}

function isRemoteSyncEnabled(account: { sync_enabled: number }) {
	return account.sync_enabled === 1;
}

function needsFreshBootstrap(
	syncState:
		| {
				uidvalidity: number | null;
				latest_uid_cursor: number | null;
				earliest_uid_cursor: number | null;
				backfill_snapshot_uid: number | null;
				last_bootstrap_completed_at: string | null;
		  }
		| undefined,
	currentUidvalidity: number,
	currentHeadUid: number,
) {
	if (!syncState) {
		return true;
	}

	if (syncState.uidvalidity === null) {
		return true;
	}

	if (syncState.uidvalidity !== currentUidvalidity) {
		return true;
	}

	if (syncState.last_bootstrap_completed_at === null) {
		return true;
	}

	if (
		currentHeadUid > 0 &&
		(syncState.latest_uid_cursor === null ||
			syncState.earliest_uid_cursor === null ||
			syncState.backfill_snapshot_uid === null)
	) {
		return true;
	}

	return false;
}

async function updateAccountSyncStatus(input: {
	accountId: string;
	status:
		| "idle"
		| "syncing"
		| "backfilling"
		| "needs_reconnect"
		| "resync_required";
	lastSyncedAt?: string | null;
	lastError?: string | null;
}) {
	const db = getDb();
	await db
		.updateTable("accounts")
		.set({
			sync_status: input.status,
			...(input.lastSyncedAt !== undefined
				? { last_synced_at: input.lastSyncedAt }
				: {}),
			...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
			updated_at: nowIso(),
		})
		.where("id", "=", input.accountId)
		.execute();
}

async function markNeedsReconnect(accountId: string) {
	await updateAccountSyncStatus({
		accountId,
		status: "needs_reconnect",
	});
}

async function markResyncRequired(accountId: string) {
	await updateAccountSyncStatus({
		accountId,
		status: "resync_required",
	});
}

async function ensureBootstrapStateRow(accountId: string, startedAt: string) {
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
			last_bootstrap_started_at: startedAt,
			last_bootstrap_completed_at: null,
			last_delta_sync_at: null,
			last_reconcile_at: null,
			last_backfill_sync_at: null,
			backfill_completed_at: null,
			last_idle_started_at: null,
			last_idle_heartbeat_at: null,
			watcher_status: "stopped",
			consecutive_failures: 0,
			backoff_until: null,
			created_at: startedAt,
			updated_at: startedAt,
		})
		.onConflict((oc) =>
			oc.column("account_id").doUpdateSet({
				uidvalidity: null,
				latest_uid_cursor: null,
				earliest_uid_cursor: null,
				backfill_snapshot_uid: null,
				backfill_next_uid: null,
				last_bootstrap_started_at: startedAt,
				last_bootstrap_completed_at: null,
				last_delta_sync_at: null,
				last_backfill_sync_at: null,
				backfill_completed_at: null,
				updated_at: startedAt,
			}),
		)
		.execute();
}

async function loadSyncState(accountId: string) {
	const db = getDb();
	return db
		.selectFrom("account_sync_state")
		.selectAll()
		.where("account_id", "=", accountId)
		.executeTakeFirst();
}

async function updateBootstrapState(input: {
	accountId: string;
	uidvalidity: number;
	latestUidCursor: number | null;
	earliestUidCursor: number | null;
	backfillSnapshotUid: number | null;
	backfillNextUid: number | null;
	lastBootstrapStartedAt: string;
	lastBootstrapCompletedAt: string;
	lastBackfillSyncAt: string | null;
	backfillCompletedAt: string | null;
}) {
	const db = getDb();
	await db
		.updateTable("account_sync_state")
		.set({
			uidvalidity: input.uidvalidity,
			latest_uid_cursor: input.latestUidCursor,
			earliest_uid_cursor: input.earliestUidCursor,
			backfill_snapshot_uid: input.backfillSnapshotUid,
			backfill_next_uid: input.backfillNextUid,
			last_bootstrap_started_at: input.lastBootstrapStartedAt,
			last_bootstrap_completed_at: input.lastBootstrapCompletedAt,
			last_backfill_sync_at: input.lastBackfillSyncAt,
			backfill_completed_at: input.backfillCompletedAt,
			updated_at: input.lastBootstrapCompletedAt,
		})
		.where("account_id", "=", input.accountId)
		.execute();
}

async function queueBackfillIfNeeded(
	accountId: string,
	backfillNextUid: number | null,
) {
	if (backfillNextUid === null) {
		return false;
	}

	await queueJobIdempotent({
		kind: "sync_account_backfill",
		scopeType: "account",
		scopeId: accountId,
	});
	return true;
}

export async function runFullSync(accountId: string, trace?: LogTrace) {
	const syncTrace =
		trace?.child({
			kind: "sync",
			operation: "run_full_sync",
			account_id: accountId,
		}) ??
		startTrace({
			kind: "sync",
			operation: "run_full_sync",
			account_id: accountId,
		});
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();
	syncTrace.add({
		mailbox: account.selected_mailbox,
	});
	syncTrace.info("sync.bootstrap.start");

	if (!isRemoteSyncEnabled(account)) {
		syncTrace.complete("sync.bootstrap.complete", {
			outcome: "skipped",
			reason: "sync_disabled",
		});
		return {
			skipped: true,
			phase: "resume" as const,
			fetched: 0,
			latestUidCursor: null,
			earliestUidCursor: null,
			backfillSnapshotUid: null,
			backfillNextUid: null,
			queuedBackfill: false,
			queuedDelta: false,
		};
	}

	try {
		const token = await ensureFreshToken(accountId);
		if (!token) {
			await markNeedsReconnect(accountId);
			throw new Error("No valid OAuth token for account");
		}

		await updateAccountSyncStatus({
			accountId,
			status: "syncing",
		});

		const client = createImapClient({
			email: account.email_address,
			accessToken: token.accessToken,
			mailbox: account.selected_mailbox,
		});

		let fetched = 0;
		let latestUidCursor: number | null = null;
		let earliestUidCursor: number | null = null;
		let backfillSnapshotUid: number | null = null;
		let backfillNextUid: number | null = null;
		let queuedDelta = false;
		let queuedBackfill = false;
		let phase: "bootstrap" | "resume" = "resume";

		try {
			await client.connect();
			const lock = await client.getMailboxLock(account.selected_mailbox);

			try {
				const status = await getMailboxStatus(client, account.selected_mailbox);
				const currentUidvalidity = Number(status.uidvalidity);
				const currentHeadUid = Math.max(0, Number(status.uidNext) - 1);
				const syncState = await loadSyncState(accountId);
				const freshBootstrap = needsFreshBootstrap(
					syncState,
					currentUidvalidity,
					currentHeadUid,
				);

				if (freshBootstrap) {
					phase = "bootstrap";
					const startedAt = nowIso();
					await ensureBootstrapStateRow(accountId, startedAt);

					if (currentHeadUid > 0) {
						const rangeStart = Math.max(
							1,
							currentHeadUid - APP_CONFIG.imapFetchWindow + 1,
						);
						const batch = await fetchMessageRange(
							client,
							rangeStart,
							currentHeadUid,
						);

						for (const msg of batch) {
							await ingestMessage(
								accountId,
								account.selected_mailbox,
								msg,
								currentUidvalidity,
								syncTrace,
							);
							fetched += 1;
						}

						latestUidCursor = currentHeadUid;
						earliestUidCursor = rangeStart;
						backfillSnapshotUid = currentHeadUid;
						backfillNextUid = rangeStart > 1 ? rangeStart - 1 : null;
					}

					const completedAt = nowIso();
					await updateBootstrapState({
						accountId,
						uidvalidity: currentUidvalidity,
						latestUidCursor,
						earliestUidCursor,
						backfillSnapshotUid,
						backfillNextUid,
						lastBootstrapStartedAt: startedAt,
						lastBootstrapCompletedAt: completedAt,
						lastBackfillSyncAt: fetched > 0 ? completedAt : null,
						backfillCompletedAt: backfillNextUid === null ? completedAt : null,
					});
				} else {
					latestUidCursor = syncState?.latest_uid_cursor ?? null;
					earliestUidCursor = syncState?.earliest_uid_cursor ?? null;
					backfillSnapshotUid = syncState?.backfill_snapshot_uid ?? null;
					backfillNextUid = syncState?.backfill_next_uid ?? null;

					const startUid = (latestUidCursor ?? 0) + 1;
					if (currentHeadUid >= startUid) {
						const rangeEnd = Math.min(
							currentHeadUid,
							startUid + APP_CONFIG.imapFetchWindow - 1,
						);
						const batch = await fetchMessageRange(client, startUid, rangeEnd);

						for (const msg of batch) {
							await ingestMessage(
								accountId,
								account.selected_mailbox,
								msg,
								currentUidvalidity,
								syncTrace,
							);
							fetched += 1;
						}

						latestUidCursor = rangeEnd;

						const completedAt = nowIso();
						await db
							.updateTable("account_sync_state")
							.set({
								uidvalidity: currentUidvalidity,
								latest_uid_cursor: latestUidCursor,
								earliest_uid_cursor: earliestUidCursor,
								last_delta_sync_at: completedAt,
								updated_at: completedAt,
							})
							.where("account_id", "=", accountId)
							.execute();

						if (currentHeadUid > rangeEnd) {
							await queueJobIdempotent({
								kind: "sync_account_delta",
								scopeType: "account",
								scopeId: accountId,
							});
							queuedDelta = true;
							syncTrace.info("sync.delta.more_queued", {
								latest_uid_cursor: latestUidCursor,
								current_head_uid: currentHeadUid,
							});
						}
					}
				}
			} finally {
				lock.release();
			}
		} finally {
			try {
				await client.logout();
			} catch {
				// ignore logout errors
			}
		}

		queuedBackfill = await queueBackfillIfNeeded(accountId, backfillNextUid);
		const completedAt = nowIso();
		await updateAccountSyncStatus({
			accountId,
			status: activeSyncStatus(backfillNextUid),
			lastSyncedAt: completedAt,
			lastError: null,
		});

		syncTrace.complete("sync.bootstrap.complete", {
			outcome: phase === "bootstrap" ? "bootstrapped" : "resumed",
			phase,
			fetched,
			latest_uid_cursor: latestUidCursor,
			earliest_uid_cursor: earliestUidCursor,
			backfill_snapshot_uid: backfillSnapshotUid,
			backfill_next_uid: backfillNextUid,
			queued_backfill: queuedBackfill,
			queued_delta: queuedDelta,
		});
		return {
			skipped: false,
			phase,
			fetched,
			latestUidCursor,
			earliestUidCursor,
			backfillSnapshotUid,
			backfillNextUid,
			queuedBackfill,
			queuedDelta,
		};
	} catch (error) {
		syncTrace.fail("sync.bootstrap.fail", error);
		throw error;
	}
}

export async function runDeltaSync(accountId: string, trace?: LogTrace) {
	const syncTrace =
		trace?.child({
			kind: "sync",
			operation: "run_delta_sync",
			account_id: accountId,
		}) ??
		startTrace({
			kind: "sync",
			operation: "run_delta_sync",
			account_id: accountId,
		});
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();
	syncTrace.add({
		mailbox: account.selected_mailbox,
	});
	syncTrace.info("sync.delta.start");

	if (!isRemoteSyncEnabled(account)) {
		syncTrace.complete("sync.delta.complete", {
			outcome: "skipped",
			reason: "sync_disabled",
		});
		return {
			skipped: true,
			fetched: 0,
			uidvalidityChanged: false,
			latestUidCursor: null,
			backfillNextUid: null,
			queuedMore: false,
		};
	}

	const syncState = await loadSyncState(accountId);
	if (!syncState) {
		throw new Error("No sync state found; run full sync first");
	}

	try {
		const token = await ensureFreshToken(accountId);
		if (!token) {
			await markNeedsReconnect(accountId);
			throw new Error("No valid OAuth token for account");
		}

		await updateAccountSyncStatus({
			accountId,
			status: "syncing",
		});

		const client = createImapClient({
			email: account.email_address,
			accessToken: token.accessToken,
		});

		let fetched = 0;
		let latestUidCursor = syncState.latest_uid_cursor;
		let queuedMore = false;

		try {
			await client.connect();
			const lock = await client.getMailboxLock(account.selected_mailbox);

			try {
				const status = await getMailboxStatus(client, account.selected_mailbox);
				const currentUidvalidity = Number(status.uidvalidity);
				if (
					syncState.uidvalidity !== null &&
					currentUidvalidity !== syncState.uidvalidity
				) {
					await markResyncRequired(accountId);
					await queueJobIdempotent({
						kind: "sync_account_full",
						scopeType: "account",
						scopeId: accountId,
					});
					syncTrace.info("sync.delta.uidvalidity_changed", {
						outcome: "resync_required",
						previous_uidvalidity: syncState.uidvalidity,
						current_uidvalidity: currentUidvalidity,
					});
					return {
						skipped: false,
						fetched: 0,
						uidvalidityChanged: true,
						latestUidCursor,
						backfillNextUid: syncState.backfill_next_uid,
						queuedMore: false,
					};
				}

				const currentHeadUid = Math.max(0, Number(status.uidNext) - 1);
				const startUid = (latestUidCursor ?? 0) + 1;
				if (currentHeadUid >= startUid) {
					const rangeEnd = Math.min(
						currentHeadUid,
						startUid + APP_CONFIG.imapFetchWindow - 1,
					);
					const batch = await fetchMessageRange(client, startUid, rangeEnd);

					for (const msg of batch) {
						await ingestMessage(
							accountId,
							account.selected_mailbox,
							msg,
							currentUidvalidity,
							syncTrace,
						);
						fetched += 1;
					}

					latestUidCursor = rangeEnd;
					const completedAt = nowIso();
					await db
						.updateTable("account_sync_state")
						.set({
							uidvalidity: currentUidvalidity,
							latest_uid_cursor: latestUidCursor,
							earliest_uid_cursor: syncState.earliest_uid_cursor ?? startUid,
							last_delta_sync_at: completedAt,
							updated_at: completedAt,
						})
						.where("account_id", "=", accountId)
						.execute();

					if (currentHeadUid > rangeEnd) {
						await queueJobIdempotent({
							kind: "sync_account_delta",
							scopeType: "account",
							scopeId: accountId,
						});
						queuedMore = true;
						syncTrace.info("sync.delta.more_queued", {
							latest_uid_cursor: latestUidCursor,
							current_head_uid: currentHeadUid,
						});
					}
				}
			} finally {
				lock.release();
			}
		} finally {
			try {
				await client.logout();
			} catch {
				// ignore
			}
		}

		const completedAt = nowIso();
		await updateAccountSyncStatus({
			accountId,
			status: activeSyncStatus(syncState.backfill_next_uid),
			lastSyncedAt: completedAt,
			lastError: null,
		});

		syncTrace.complete("sync.delta.complete", {
			fetched,
			latest_uid_cursor: latestUidCursor,
			backfill_next_uid: syncState.backfill_next_uid,
			queued_more: queuedMore,
		});
		return {
			skipped: false,
			fetched,
			uidvalidityChanged: false,
			latestUidCursor,
			backfillNextUid: syncState.backfill_next_uid,
			queuedMore,
		};
	} catch (error) {
		syncTrace.fail("sync.delta.fail", error);
		throw error;
	}
}

export async function runBackfillSync(accountId: string, trace?: LogTrace) {
	const syncTrace =
		trace?.child({
			kind: "sync",
			operation: "run_backfill_sync",
			account_id: accountId,
		}) ??
		startTrace({
			kind: "sync",
			operation: "run_backfill_sync",
			account_id: accountId,
		});
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();
	syncTrace.add({
		mailbox: account.selected_mailbox,
	});
	syncTrace.info("sync.backfill.start");

	if (!isRemoteSyncEnabled(account)) {
		syncTrace.complete("sync.backfill.complete", {
			outcome: "skipped",
			reason: "sync_disabled",
		});
		return {
			skipped: true,
			fetched: 0,
			earliestUidCursor: null,
			backfillNextUid: null,
			rangeStart: null,
			rangeEnd: null,
			queuedMore: false,
			uidvalidityChanged: false,
		};
	}

	const syncState = await loadSyncState(accountId);
	if (!syncState) {
		throw new Error("No sync state found; run full sync first");
	}

	if (syncState.backfill_next_uid === null) {
		await updateAccountSyncStatus({
			accountId,
			status: "idle",
			lastSyncedAt: nowIso(),
			lastError: null,
		});
		syncTrace.complete("sync.backfill.complete", {
			outcome: "already_complete",
			earliest_uid_cursor: syncState.earliest_uid_cursor,
		});
		return {
			skipped: false,
			fetched: 0,
			earliestUidCursor: syncState.earliest_uid_cursor,
			backfillNextUid: null,
			rangeStart: null,
			rangeEnd: null,
			queuedMore: false,
			uidvalidityChanged: false,
		};
	}

	try {
		const token = await ensureFreshToken(accountId);
		if (!token) {
			await markNeedsReconnect(accountId);
			throw new Error("No valid OAuth token for account");
		}

		await updateAccountSyncStatus({
			accountId,
			status: "syncing",
		});

		const client = createImapClient({
			email: account.email_address,
			accessToken: token.accessToken,
		});

		let fetched = 0;
		const rangeEnd = syncState.backfill_next_uid;
		const rangeStart = Math.max(1, rangeEnd - APP_CONFIG.imapFetchWindow + 1);
		let earliestUidCursor = syncState.earliest_uid_cursor;
		let backfillNextUid: number | null = syncState.backfill_next_uid;
		let queuedMore = false;

		try {
			await client.connect();
			const lock = await client.getMailboxLock(account.selected_mailbox);

			try {
				const status = await getMailboxStatus(client, account.selected_mailbox);
				const currentUidvalidity = Number(status.uidvalidity);
				if (
					syncState.uidvalidity !== null &&
					currentUidvalidity !== syncState.uidvalidity
				) {
					await markResyncRequired(accountId);
					await queueJobIdempotent({
						kind: "sync_account_full",
						scopeType: "account",
						scopeId: accountId,
					});
					syncTrace.complete("sync.backfill.complete", {
						outcome: "resync_required",
						previous_uidvalidity: syncState.uidvalidity,
						current_uidvalidity: currentUidvalidity,
					});
					return {
						skipped: false,
						fetched: 0,
						earliestUidCursor,
						backfillNextUid,
						rangeStart,
						rangeEnd,
						queuedMore: false,
						uidvalidityChanged: true,
					};
				}

				const batch = await fetchMessageWindowDescending(
					client,
					rangeEnd,
					APP_CONFIG.imapFetchWindow,
				);

				for (const msg of batch) {
					await ingestMessage(
						accountId,
						account.selected_mailbox,
						msg,
						currentUidvalidity,
						syncTrace,
					);
					fetched += 1;
				}

				earliestUidCursor = rangeStart;
				backfillNextUid = rangeStart > 1 ? rangeStart - 1 : null;
				const completedAt = nowIso();
				await db
					.updateTable("account_sync_state")
					.set({
						uidvalidity: currentUidvalidity,
						earliest_uid_cursor: earliestUidCursor,
						backfill_next_uid: backfillNextUid,
						last_backfill_sync_at: completedAt,
						backfill_completed_at:
							backfillNextUid === null ? completedAt : null,
						updated_at: completedAt,
					})
					.where("account_id", "=", accountId)
					.execute();

				queuedMore = await queueBackfillIfNeeded(accountId, backfillNextUid);
			} finally {
				lock.release();
			}
		} finally {
			try {
				await client.logout();
			} catch {
				// ignore
			}
		}

		const completedAt = nowIso();
		await updateAccountSyncStatus({
			accountId,
			status: activeSyncStatus(backfillNextUid),
			lastSyncedAt: completedAt,
			lastError: null,
		});

		syncTrace.complete("sync.backfill.complete", {
			fetched,
			range_start: rangeStart,
			range_end: rangeEnd,
			earliest_uid_cursor: earliestUidCursor,
			backfill_next_uid: backfillNextUid,
			queued_more: queuedMore,
		});
		return {
			skipped: false,
			fetched,
			earliestUidCursor,
			backfillNextUid,
			rangeStart,
			rangeEnd,
			queuedMore,
			uidvalidityChanged: false,
		};
	} catch (error) {
		syncTrace.fail("sync.backfill.fail", error);
		throw error;
	}
}

export async function runReconcile(accountId: string, trace?: LogTrace) {
	const syncTrace =
		trace?.child({
			kind: "sync",
			operation: "run_reconcile",
			account_id: accountId,
		}) ??
		startTrace({
			kind: "sync",
			operation: "run_reconcile",
			account_id: accountId,
		});
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();
	syncTrace.add({
		mailbox: account.selected_mailbox,
	});
	syncTrace.info("sync.reconcile.start");

	if (!isRemoteSyncEnabled(account)) {
		syncTrace.complete("sync.reconcile.complete", {
			outcome: "skipped",
			reason: "sync_disabled",
			tombstoned: 0,
		});
		return { skipped: true, tombstoned: 0 };
	}

	const syncState = await loadSyncState(accountId);
	if (
		!syncState ||
		syncState.uidvalidity === null ||
		syncState.earliest_uid_cursor === null ||
		syncState.latest_uid_cursor === null
	) {
		syncTrace.complete("sync.reconcile.complete", {
			outcome: "skipped",
			reason: "window_unavailable",
			tombstoned: 0,
			earliest_uid_cursor: syncState?.earliest_uid_cursor ?? null,
			latest_uid_cursor: syncState?.latest_uid_cursor ?? null,
		});
		return { skipped: true, tombstoned: 0 };
	}

	const earliestUidCursor = syncState.earliest_uid_cursor;
	const latestUidCursor = syncState.latest_uid_cursor;
	syncTrace.add({
		earliest_uid_cursor: earliestUidCursor,
		latest_uid_cursor: latestUidCursor,
	});

	try {
		const token = await ensureFreshToken(accountId);
		if (!token) {
			await markNeedsReconnect(accountId);
			throw new Error("No valid OAuth token for account");
		}

		const client = createImapClient({
			email: account.email_address,
			accessToken: token.accessToken,
		});

		let tombstoned = 0;

		try {
			await client.connect();
			const status = await getMailboxStatus(client, account.selected_mailbox);
			const currentUidvalidity = Number(status.uidvalidity);
			if (currentUidvalidity !== syncState.uidvalidity) {
				await markResyncRequired(accountId);
				await queueJobIdempotent({
					kind: "sync_account_full",
					scopeType: "account",
					scopeId: accountId,
				});
				syncTrace.complete("sync.reconcile.complete", {
					outcome: "skipped",
					reason: "uidvalidity_changed",
					tombstoned: 0,
					uidvalidity: syncState.uidvalidity,
					current_uidvalidity: currentUidvalidity,
					earliest_uid_cursor: earliestUidCursor,
					latest_uid_cursor: latestUidCursor,
				});
				return { skipped: true, tombstoned: 0 };
			}

			const lock = await client.getMailboxLock(account.selected_mailbox);

			try {
				const remoteIds = new Set<string>();
				for await (const msg of client.fetch(
					`${earliestUidCursor}:${latestUidCursor}`,
					{
						uid: true,
					},
					{ uid: true },
				)) {
					const extra = msg as unknown as Record<string, unknown>;
					const gmMsgId = String(msg.emailId ?? extra["x-gm-msgid"] ?? "");
					if (gmMsgId) {
						remoteIds.add(gmMsgId);
					}
				}

				const localSources = await db
					.selectFrom("message_sources")
					.select(["id", "remote_message_id"])
					.where("account_id", "=", accountId)
					.where("state", "=", "active")
					.where("uidvalidity", "=", syncState.uidvalidity)
					.where("imap_uid", ">=", earliestUidCursor)
					.where("imap_uid", "<=", latestUidCursor)
					.execute();

				const completedAt = nowIso();
				for (const source of localSources) {
					if (
						source.remote_message_id &&
						!remoteIds.has(source.remote_message_id)
					) {
						await db
							.updateTable("message_sources")
							.set({
								state: "tombstoned",
								tombstoned_at: completedAt,
								updated_at: completedAt,
							})
							.where("id", "=", source.id)
							.execute();
						tombstoned += 1;
					}
				}
			} finally {
				lock.release();
			}
		} finally {
			try {
				await client.logout();
			} catch {
				// ignore
			}
		}

		const completedAt = nowIso();
		await db
			.updateTable("account_sync_state")
			.set({ last_reconcile_at: completedAt, updated_at: completedAt })
			.where("account_id", "=", accountId)
			.execute();

		syncTrace.complete("sync.reconcile.complete", {
			tombstoned,
			range_start: earliestUidCursor,
			range_end: latestUidCursor,
		});
		return { skipped: false, tombstoned };
	} catch (error) {
		syncTrace.fail("sync.reconcile.fail", error);
		throw error;
	}
}

async function ingestMessage(
	accountId: string,
	mailbox: string,
	msg: {
		uid: number;
		gmMsgId: string;
		gmThrid: string;
		internalDate: Date;
		raw: Buffer;
		sha256: string;
	},
	uidvalidity: number,
	trace?: LogTrace,
) {
	const db = getDb();

	const existing = await db
		.selectFrom("message_sources")
		.select(["id", "message_id", "raw_sha256"])
		.where("account_id", "=", accountId)
		.where("remote_message_id", "=", msg.gmMsgId)
		.executeTakeFirst();

	if (existing) {
		const now = nowIso();
		await db
			.updateTable("message_sources")
			.set({
				last_seen_at: now,
				imap_uid: msg.uid,
				uidvalidity,
				state: "active",
				tombstoned_at: null,
				updated_at: now,
			})
			.where("id", "=", existing.id)
			.execute();

		if (existing.raw_sha256 !== msg.sha256) {
			const rawPath = writeRawEml(accountId, msg.gmMsgId, msg.raw);
			const parsed = await parseRawMessage(msg.raw, msg.sha256);
			if (parsed.parseStatus === "error") {
				trace?.info("sync.message.parse_error", {
					outcome: "parse_error",
					remote_message_id: msg.gmMsgId,
					uid: msg.uid,
				});
			}
			const receivedAtFallback = msg.internalDate.toISOString();
			await db.transaction().execute(async (trx) => {
				await trx
					.updateTable("messages")
					.set(parsedMessageValues(parsed, msg.raw.length, receivedAtFallback))
					.where("id", "=", existing.message_id)
					.execute();
				await replaceAttachments(trx, existing.message_id, parsed.attachments);

				await trx
					.updateTable("message_sources")
					.set({
						last_seen_at: now,
						imap_uid: msg.uid,
						uidvalidity,
						state: "active",
						tombstoned_at: null,
						raw_rfc822_path: rawPath,
						raw_sha256: msg.sha256,
						updated_at: now,
					})
					.where("id", "=", existing.id)
					.execute();
			});
			return;
		}
		return;
	}

	const rawPath = writeRawEml(accountId, msg.gmMsgId, msg.raw);
	const parsed = await parseRawMessage(msg.raw, msg.sha256);
	if (parsed.parseStatus === "error") {
		trace?.info("sync.message.parse_error", {
			outcome: "parse_error",
			remote_message_id: msg.gmMsgId,
			uid: msg.uid,
		});
	}
	const now = nowIso();
	const receivedAtFallback = msg.internalDate.toISOString();

	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("messages")
			.values({
				id: parsed.id,
				account_id: accountId,
				...parsedMessageValues(parsed, msg.raw.length, receivedAtFallback),
				created_at: now,
			})
			.execute();

		await replaceAttachments(trx, parsed.id, parsed.attachments);

		await trx
			.insertInto("message_sources")
			.values({
				id: randomUUID(),
				message_id: parsed.id,
				account_id: accountId,
				remote_message_id: msg.gmMsgId,
				remote_thread_id: msg.gmThrid,
				mailbox,
				imap_uid: msg.uid,
				uidvalidity,
				raw_rfc822_path: rawPath,
				raw_sha256: msg.sha256,
				state: "active",
				first_seen_at: now,
				last_seen_at: now,
				tombstoned_at: null,
				updated_at: now,
			})
			.execute();
	});
}
