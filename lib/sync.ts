import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { FetchQueryObject } from "imapflow";
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
import { isBadNormalizedBody } from "#/lib/normalize";
import { recordSyncBatch } from "#/lib/observability";
import { currentOrgId } from "#/lib/runtime";
import { publishActionEvent } from "#/lib/runtime-events";

const OAUTH_RECONNECT_REQUIRED_MESSAGE =
	"Gmail OAuth token is missing or no longer valid. Reconnect this Gmail account.";

export interface SyncProgressSink {
	onProgress(input: {
		phase: "full" | "delta" | "backfill";
		fetched: number;
		total: number | null;
		rangeStart?: number | null;
		rangeEnd?: number | null;
		backfillNextUid?: number | null;
	}): Promise<void> | void;
}

function parsedMessageValues(
	parsed: Awaited<ReturnType<typeof parseRawMessage>>,
	rawLength: number,
	conversationId: string | null,
) {
	return {
		message_id: parsed.messageId,
		thread_key: parsed.threadKey,
		received_at: parsed.receivedAt,
		conversation_id: conversationId,
		sender_name: parsed.senderName,
		sender_address: parsed.senderAddress,
		to_json: parsed.toJson,
		cc_json: parsed.ccJson,
		subject: parsed.subject,
		in_reply_to: parsed.inReplyTo,
		body_text_primary: parsed.bodyTextPrimary,
		body_text_forwarded: parsed.bodyTextForwarded,
		body_text_normalized: parsed.bodyTextNormalized,
		snippet: parsed.snippet,
		attachment_count: parsed.attachmentCount,
		has_html: parsed.hasHtml,
		raw_byte_start: 0,
		raw_byte_end: rawLength,
		parse_status: parsed.parseStatus,
		body_extraction_strategy: parsed.bodyExtractionStrategy,
		parse_error_reason: parsed.parseErrorReason,
		token_estimate: parsed.tokenEstimate,
		content_sha256: parsed.contentSha256,
	};
}

type SyncExecutor = Kysely<DB> | Transaction<DB>;
type ParsedMessage = Awaited<ReturnType<typeof parseRawMessage>>;

function sourceStatePriority(state: string) {
	return state === "active" ? 0 : 1;
}

function selectPreferredSource<
	T extends {
		state: string;
		updated_at: string;
	},
>(rows: T[]) {
	return [...rows].sort((left, right) => {
		const stateOrder =
			sourceStatePriority(left.state) - sourceStatePriority(right.state);
		if (stateOrder !== 0) {
			return stateOrder;
		}
		return right.updated_at.localeCompare(left.updated_at);
	})[0];
}

function buildRawRfc822Sha256(raw: Buffer) {
	return createHash("sha256").update(raw).digest("hex");
}

async function ensureConversationId(
	executor: SyncExecutor,
	accountId: string,
	gmailThreadId: string | null | undefined,
	now: string,
) {
	const normalizedThreadId = gmailThreadId?.trim() ?? "";
	if (!normalizedThreadId) {
		return null;
	}

	const existing = await executor
		.selectFrom("conversations")
		.select("id")
		.where("account_id", "=", accountId)
		.where("gmail_thread_id", "=", normalizedThreadId)
		.executeTakeFirst();
	if (existing) {
		return existing.id;
	}

	const id = randomUUID();
	await executor
		.insertInto("conversations")
		.values({
			id,
			account_id: accountId,
			gmail_thread_id: normalizedThreadId,
			first_message_received_at: null,
			last_message_received_at: null,
			message_count: 0,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.columns(["account_id", "gmail_thread_id"]).doNothing(),
		)
		.execute();

	const row = await executor
		.selectFrom("conversations")
		.select("id")
		.where("account_id", "=", accountId)
		.where("gmail_thread_id", "=", normalizedThreadId)
		.executeTakeFirstOrThrow();
	return row.id;
}

async function refreshConversationRollup(
	executor: SyncExecutor,
	conversationId: string | null,
	now: string,
) {
	if (!conversationId) {
		return;
	}

	const rollup = await executor
		.selectFrom("messages")
		.select([
			(eb) => eb.fn.countAll<number>().as("message_count"),
			(eb) => eb.fn.min("received_at").as("first_message_received_at"),
			(eb) => eb.fn.max("received_at").as("last_message_received_at"),
		])
		.where("conversation_id", "=", conversationId)
		.executeTakeFirstOrThrow();

	if (Number(rollup.message_count) === 0) {
		await executor
			.deleteFrom("conversations")
			.where("id", "=", conversationId)
			.execute();
		return;
	}

	await executor
		.updateTable("conversations")
		.set({
			message_count: Number(rollup.message_count),
			first_message_received_at: rollup.first_message_received_at ?? null,
			last_message_received_at: rollup.last_message_received_at ?? null,
			updated_at: now,
		})
		.where("id", "=", conversationId)
		.execute();
}

async function replaceAttachments(
	executor: SyncExecutor,
	messageId: string,
	attachments: ParsedMessage["attachments"],
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

async function applyParsedMessageUpdate(input: {
	executor: SyncExecutor;
	messageId: string;
	accountId: string;
	previousConversationId: string | null;
	remoteThreadId: string | null;
	now: string;
	rawLength: number;
	parsed: ParsedMessage;
	sourceId: string;
	sourceUpdate: Partial<DB["message_sources"]> &
		Pick<DB["message_sources"], "updated_at">;
}) {
	const conversationId = await ensureConversationId(
		input.executor,
		input.accountId,
		input.remoteThreadId,
		input.now,
	);
	await input.executor
		.updateTable("messages")
		.set(parsedMessageValues(input.parsed, input.rawLength, conversationId))
		.where("id", "=", input.messageId)
		.execute();
	await replaceAttachments(
		input.executor,
		input.messageId,
		input.parsed.attachments,
	);
	await input.executor
		.updateTable("message_sources")
		.set(input.sourceUpdate)
		.where("id", "=", input.sourceId)
		.execute();
	for (const conversationToRefresh of new Set([
		input.previousConversationId,
		conversationId,
	])) {
		await refreshConversationRollup(
			input.executor,
			conversationToRefresh,
			input.now,
		);
	}
}

export async function reextractStoredParseErrorMessage(input: {
	messageId: string;
}) {
	return reextractStoredMessage({
		messageId: input.messageId,
		acceptParsed: (parsed) => parsed.parseStatus !== "error",
	});
}

export async function reextractStoredBadBodyMessage(input: {
	messageId: string;
}) {
	return reextractStoredMessage({
		messageId: input.messageId,
		acceptParsed: (parsed) =>
			parsed.parseStatus !== "error" &&
			!isBadNormalizedBody({
				bodyTextPrimary: parsed.bodyTextPrimary,
				snippet: parsed.snippet,
				bodyExtractionStrategy: parsed.bodyExtractionStrategy,
			}),
	});
}

async function reextractStoredMessage(input: {
	messageId: string;
	acceptParsed: (parsed: ParsedMessage) => boolean;
}) {
	const db = getDb();
	const now = nowIso();
	const message = await db
		.selectFrom("messages")
		.select([
			"id",
			"account_id",
			"received_at",
			"conversation_id",
			"created_at",
			"ingested_at",
		])
		.where("id", "=", input.messageId)
		.executeTakeFirstOrThrow();
	const sourceRows = await db
		.selectFrom("message_sources")
		.selectAll()
		.where("message_id", "=", input.messageId)
		.execute();
	const source = selectPreferredSource(sourceRows);

	if (!source?.raw_rfc822_path) {
		return {
			outcome: "missingRaw" as const,
			accountId: message.account_id,
			messageId: message.id,
			createdAt: message.created_at,
			ingestedAt: message.ingested_at,
		};
	}

	let raw: Buffer;
	try {
		raw = readFileSync(source.raw_rfc822_path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {
				outcome: "missingRaw" as const,
				accountId: message.account_id,
				messageId: message.id,
				createdAt: message.created_at,
				ingestedAt: message.ingested_at,
			};
		}
		throw error;
	}

	const rawSha256 = buildRawRfc822Sha256(raw);
	const parsed = await parseRawMessage(raw, rawSha256, message.received_at);
	if (!input.acceptParsed(parsed)) {
		return {
			outcome: "stillFailing" as const,
			accountId: message.account_id,
			messageId: message.id,
			createdAt: message.created_at,
			ingestedAt: message.ingested_at,
			parseErrorReason: parsed.parseErrorReason,
		};
	}

	await db.transaction().execute(async (trx) => {
		await applyParsedMessageUpdate({
			executor: trx,
			messageId: message.id,
			accountId: message.account_id,
			previousConversationId: message.conversation_id,
			remoteThreadId: source.remote_thread_id,
			now,
			rawLength: raw.length,
			parsed,
			sourceId: source.id,
			sourceUpdate: {
				raw_sha256:
					source.raw_sha256 === rawSha256 ? source.raw_sha256 : rawSha256,
				updated_at: now,
			},
		});
	});

	return {
		outcome: "recovered" as const,
		accountId: message.account_id,
		messageId: message.id,
		createdAt: message.created_at,
		ingestedAt: message.ingested_at,
	};
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
	const payload = {
		accountId: input.accountId,
		syncStatus: input.status,
		lastSyncedAt: input.lastSyncedAt ?? null,
		lastError: input.lastError ?? null,
	};
	await publishActionEvent({
		topic: `account:${input.accountId}`,
		eventType: "account.sync_status",
		entityKind: "account",
		entityId: input.accountId,
		payload,
	});
	await publishActionEvent({
		topic: "accounts",
		eventType: "account.sync_status",
		entityKind: "account",
		entityId: input.accountId,
		payload,
	});
}

async function markNeedsReconnect(accountId: string) {
	await updateAccountSyncStatus({
		accountId,
		status: "needs_reconnect",
		lastError: OAUTH_RECONNECT_REQUIRED_MESSAGE,
	});
}

async function markResyncRequired(accountId: string) {
	await updateAccountSyncStatus({
		accountId,
		status: "resync_required",
	});
}

async function setAccountLastError(
	accountId: string,
	lastError: string | null,
) {
	await getDb()
		.updateTable("accounts")
		.set({
			last_error: lastError,
			updated_at: nowIso(),
		})
		.where("id", "=", accountId)
		.execute();
}

async function requireFreshTokenForSync(accountId: string) {
	try {
		const token = await ensureFreshToken(accountId);
		if (!token) {
			await markNeedsReconnect(accountId);
			throw new Error(OAUTH_RECONNECT_REQUIRED_MESSAGE);
		}
		return token;
	} catch (error) {
		await setAccountLastError(
			accountId,
			error instanceof Error ? error.message : String(error),
		);
		throw error;
	}
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

function createProgressEmitter(
	progress: SyncProgressSink | undefined,
	phase: "full" | "delta" | "backfill",
) {
	let lastEmittedAt = Date.now();
	return async (
		input: {
			fetched: number;
			total: number | null;
			rangeStart?: number | null;
			rangeEnd?: number | null;
			backfillNextUid?: number | null;
		},
		force = false,
	) => {
		if (!progress) {
			return;
		}
		const now = Date.now();
		if (!force && input.fetched % 25 !== 0 && now - lastEmittedAt < 2000) {
			return;
		}
		if (!force && now - lastEmittedAt < 2000) {
			return;
		}
		lastEmittedAt = now;
		await progress.onProgress({
			phase,
			...input,
		});
	};
}

export async function runFullSync(
	accountId: string,
	trace?: LogTrace,
	progress?: SyncProgressSink,
) {
	const syncStartedAt = Date.now();
	const reportProgress = createProgressEmitter(progress, "full");
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
		const token = await requireFreshTokenForSync(accountId);

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
						const total = currentHeadUid - rangeStart + 1;

						for (const msg of batch) {
							await ingestMessage(
								accountId,
								account.selected_mailbox,
								msg,
								currentUidvalidity,
								syncTrace,
							);
							fetched += 1;
							await reportProgress({
								fetched,
								total,
								rangeStart,
								rangeEnd: currentHeadUid,
							});
						}
						await reportProgress(
							{
								fetched,
								total,
								rangeStart,
								rangeEnd: currentHeadUid,
								backfillNextUid: rangeStart > 1 ? rangeStart - 1 : null,
							},
							true,
						);

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
						const total = rangeEnd - startUid + 1;

						for (const msg of batch) {
							await ingestMessage(
								accountId,
								account.selected_mailbox,
								msg,
								currentUidvalidity,
								syncTrace,
							);
							fetched += 1;
							await reportProgress({
								fetched,
								total,
								rangeStart: startUid,
								rangeEnd,
							});
						}
						await reportProgress(
							{
								fetched,
								total,
								rangeStart: startUid,
								rangeEnd,
							},
							true,
						);

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
		recordSyncBatch({
			orgId: currentOrgId(),
			accountId,
			phase: "full",
			fetched,
			durationMs: Date.now() - syncStartedAt,
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

export async function runDeltaSync(
	accountId: string,
	trace?: LogTrace,
	progress?: SyncProgressSink,
) {
	const syncStartedAt = Date.now();
	const reportProgress = createProgressEmitter(progress, "delta");
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
		const token = await requireFreshTokenForSync(accountId);

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
					const total = rangeEnd - startUid + 1;

					for (const msg of batch) {
						await ingestMessage(
							accountId,
							account.selected_mailbox,
							msg,
							currentUidvalidity,
							syncTrace,
						);
						fetched += 1;
						await reportProgress({
							fetched,
							total,
							rangeStart: startUid,
							rangeEnd,
							backfillNextUid: syncState.backfill_next_uid,
						});
					}
					await reportProgress(
						{
							fetched,
							total,
							rangeStart: startUid,
							rangeEnd,
							backfillNextUid: syncState.backfill_next_uid,
						},
						true,
					);

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
		recordSyncBatch({
			orgId: currentOrgId(),
			accountId,
			phase: "delta",
			fetched,
			durationMs: Date.now() - syncStartedAt,
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

export async function runBackfillSync(
	accountId: string,
	trace?: LogTrace,
	progress?: SyncProgressSink,
) {
	const syncStartedAt = Date.now();
	const reportProgress = createProgressEmitter(progress, "backfill");
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
		const token = await requireFreshTokenForSync(accountId);

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
				const total = rangeEnd - rangeStart + 1;

				for (const msg of batch) {
					await ingestMessage(
						accountId,
						account.selected_mailbox,
						msg,
						currentUidvalidity,
						syncTrace,
					);
					fetched += 1;
					await reportProgress({
						fetched,
						total,
						rangeStart,
						rangeEnd,
						backfillNextUid,
					});
				}

				earliestUidCursor = rangeStart;
				backfillNextUid = rangeStart > 1 ? rangeStart - 1 : null;
				await reportProgress(
					{
						fetched,
						total,
						rangeStart,
						rangeEnd,
						backfillNextUid,
					},
					true,
				);
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

				queuedMore = backfillNextUid !== null;
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
		recordSyncBatch({
			orgId: currentOrgId(),
			accountId,
			phase: "backfill",
			fetched,
			durationMs: Date.now() - syncStartedAt,
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
		const token = await requireFreshTokenForSync(accountId);

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
				const reconcileFetchQuery: FetchQueryObject & {
					emailId: true;
				} = {
					uid: true,
					emailId: true,
				};
				for await (const msg of client.fetch(
					`${earliestUidCursor}:${latestUidCursor}`,
					reconcileFetchQuery,
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
		await setAccountLastError(accountId, null);

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
	const remoteThreadId = msg.gmThrid.trim() || null;
	const now = nowIso();

	const existing = await db
		.selectFrom("message_sources")
		.innerJoin("messages", "messages.id", "message_sources.message_id")
		.select([
			"message_sources.id as source_id",
			"message_sources.message_id",
			"message_sources.raw_sha256",
			"message_sources.remote_thread_id",
			"messages.conversation_id",
		])
		.where("message_sources.account_id", "=", accountId)
		.where("message_sources.remote_message_id", "=", msg.gmMsgId)
		.executeTakeFirst();

	if (existing) {
		if (existing.raw_sha256 === msg.sha256) {
			if ((existing.remote_thread_id ?? null) === remoteThreadId) {
				await db
					.updateTable("message_sources")
					.set({
						remote_thread_id: remoteThreadId,
						mailbox,
						last_seen_at: now,
						imap_uid: msg.uid,
						uidvalidity,
						state: "active",
						tombstoned_at: null,
						updated_at: now,
					})
					.where("id", "=", existing.source_id)
					.execute();
				return;
			}

			await db.transaction().execute(async (trx) => {
				const conversationId = await ensureConversationId(
					trx,
					accountId,
					remoteThreadId,
					now,
				);
				await trx
					.updateTable("message_sources")
					.set({
						remote_thread_id: remoteThreadId,
						mailbox,
						last_seen_at: now,
						imap_uid: msg.uid,
						uidvalidity,
						state: "active",
						tombstoned_at: null,
						updated_at: now,
					})
					.where("id", "=", existing.source_id)
					.execute();
				await trx
					.updateTable("messages")
					.set({
						conversation_id: conversationId,
					})
					.where("id", "=", existing.message_id)
					.execute();
				for (const conversationToRefresh of new Set([
					existing.conversation_id,
					conversationId,
				])) {
					await refreshConversationRollup(trx, conversationToRefresh, now);
				}
			});
			return;
		}

		const rawPath = writeRawEml(accountId, msg.gmMsgId, msg.raw);
		const parsed = await parseRawMessage(
			msg.raw,
			msg.sha256,
			msg.internalDate.toISOString(),
		);
		if (parsed.parseStatus === "error") {
			trace?.info("sync.message.parse_error", {
				outcome: "parse_error",
				remote_message_id: msg.gmMsgId,
				uid: msg.uid,
			});
		}
		await db.transaction().execute(async (trx) => {
			await applyParsedMessageUpdate({
				executor: trx,
				messageId: existing.message_id,
				accountId,
				previousConversationId: existing.conversation_id,
				remoteThreadId,
				now,
				rawLength: msg.raw.length,
				parsed,
				sourceId: existing.source_id,
				sourceUpdate: {
					remote_thread_id: remoteThreadId,
					mailbox,
					last_seen_at: now,
					imap_uid: msg.uid,
					uidvalidity,
					state: "active",
					tombstoned_at: null,
					raw_rfc822_path: rawPath,
					raw_sha256: msg.sha256,
					updated_at: now,
				},
			});
		});
		return;
	}

	const rawPath = writeRawEml(accountId, msg.gmMsgId, msg.raw);
	const parsed = await parseRawMessage(
		msg.raw,
		msg.sha256,
		msg.internalDate.toISOString(),
	);
	if (parsed.parseStatus === "error") {
		trace?.info("sync.message.parse_error", {
			outcome: "parse_error",
			remote_message_id: msg.gmMsgId,
			uid: msg.uid,
		});
	}

	await db.transaction().execute(async (trx) => {
		const conversationId = await ensureConversationId(
			trx,
			accountId,
			remoteThreadId,
			now,
		);
		await trx
			.insertInto("messages")
			.values({
				id: parsed.id,
				account_id: accountId,
				ingested_at: now,
				...parsedMessageValues(parsed, msg.raw.length, conversationId),
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
				remote_thread_id: remoteThreadId,
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
		await refreshConversationRollup(trx, conversationId, now);
	});
}
