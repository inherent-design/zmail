import {
	buildAttachmentSummary,
	classifyMessageNow,
	mergeAllowedTags,
} from "#/lib/classify";
import {
	APP_CONFIG,
	CLASSIFY_PROMPT_VERSION,
	OVERSEER_PROMPT_VERSION,
} from "#/lib/config";
import { getDb, runMigrations } from "#/lib/db";
import {
	claimNextJob,
	completeJob,
	extendJobLease,
	failJob,
	type JobRecord,
	queueJobIdempotent,
	requeueExpiredJobs,
	updateJob,
} from "#/lib/jobs";
import { type LogTrace, startTrace } from "#/lib/log";
import {
	ensureModerationForMessage,
	topModerationScores,
} from "#/lib/moderation";
import {
	buildOverseerProfile,
	loadLatestOverseerContext,
	maybeQueueOverseerForAccount,
} from "#/lib/overseer";

declare global {
	var __zmailWorkerStarted__: boolean | undefined;
	var __zmailWorkerLoop__: Promise<void> | undefined;
}

export function delay(ms: number) {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, ms);
	});
}

async function runConcurrent<T>(
	items: T[],
	worker: (item: T) => Promise<void>,
	onProgress: (item: T, error: unknown | null) => Promise<void>,
) {
	let index = 0;

	async function loop() {
		while (true) {
			const currentIndex = index;
			index += 1;
			const item = items[currentIndex];
			if (!item) {
				return;
			}

			let error: unknown | null = null;
			try {
				await worker(item);
			} catch (workerError) {
				error = workerError;
			}
			await onProgress(item, error);
		}
	}

	await Promise.all(
		Array.from(
			{
				length: Math.min(APP_CONFIG.liveConcurrency, Math.max(items.length, 1)),
			},
			() => loop(),
		),
	);
}

async function rebuildOverseerJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "rebuild_overseer",
	});
	const profile = await buildOverseerProfile(job.scope_id);
	await completeJob({
		id: job.id,
		successCount: profile.builtFromMessages,
		errorCount: 0,
		meta: {
			mode: "live",
			processed: profile.builtFromMessages,
			total: profile.builtFromMessages,
		},
	});
	jobTrace.complete("worker.rebuild_overseer.complete", {
		processed: profile.builtFromMessages,
		total: profile.builtFromMessages,
	});
}

async function queueAccountBacklog(accountId: string) {
	await queueJobIdempotent({
		kind: "classify_account_backlog",
		scopeType: "account",
		scopeId: accountId,
		model: APP_CONFIG.classifierModel,
		promptVersion: CLASSIFY_PROMPT_VERSION,
	});
}

async function syncAccountFullJob(job: JobRecord, trace?: LogTrace) {
	const { runFullSync } = await import("#/lib/sync");
	const result = await runFullSync(
		job.scope_id,
		trace?.child({
			kind: "sync",
			operation: "sync_account_full",
			job_id: job.id,
			job_kind: job.kind,
			account_id: job.scope_id,
		}),
	);
	await completeJob({
		id: job.id,
		successCount: result.fetched,
		errorCount: 0,
		meta: {
			mode: "live",
			phase: result.phase,
			processed: result.fetched,
			total: result.fetched,
			skipped: result.skipped,
			latestUidCursor: result.latestUidCursor,
			earliestUidCursor: result.earliestUidCursor,
			backfillSnapshotUid: result.backfillSnapshotUid,
			backfillNextUid: result.backfillNextUid,
			queuedBackfill: result.queuedBackfill,
			queuedDelta: result.queuedDelta,
		},
	});

	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.select(["sync_enabled", "provider_kind"])
		.where("id", "=", job.scope_id)
		.executeTakeFirst();

	if (account?.sync_enabled === 1 && account.provider_kind === "gmail") {
		const { startWatcher } = await import("#/lib/watchers");
		await startWatcher(
			job.scope_id,
			trace?.child({
				kind: "watcher",
				operation: "start_watcher",
				account_id: job.scope_id,
				job_id: job.id,
			}),
		);
	}

	if (result.fetched > 0) {
		await queueAccountBacklog(job.scope_id);
	}
}

async function syncAccountDeltaJob(job: JobRecord, trace?: LogTrace) {
	const { runDeltaSync } = await import("#/lib/sync");
	const result = await runDeltaSync(
		job.scope_id,
		trace?.child({
			kind: "sync",
			operation: "sync_account_delta",
			job_id: job.id,
			job_kind: job.kind,
			account_id: job.scope_id,
		}),
	);
	await completeJob({
		id: job.id,
		successCount: result.fetched,
		errorCount: 0,
		meta: {
			mode: "live",
			phase: "delta",
			skipped: result.skipped,
			fetched: result.fetched,
			uidvalidityChanged: result.uidvalidityChanged,
			latestUidCursor: result.latestUidCursor,
			backfillNextUid: result.backfillNextUid,
			queuedMore: result.queuedMore,
		},
	});

	if (result.fetched > 0) {
		await queueAccountBacklog(job.scope_id);
	}
}

async function syncAccountBackfillJob(job: JobRecord, trace?: LogTrace) {
	const { runBackfillSync } = await import("#/lib/sync");
	const result = await runBackfillSync(
		job.scope_id,
		trace?.child({
			kind: "sync",
			operation: "sync_account_backfill",
			job_id: job.id,
			job_kind: job.kind,
			account_id: job.scope_id,
		}),
	);
	await completeJob({
		id: job.id,
		successCount: result.fetched,
		errorCount: 0,
		meta: {
			mode: "live",
			phase: "backfill",
			skipped: result.skipped,
			fetched: result.fetched,
			earliestUidCursor: result.earliestUidCursor,
			backfillNextUid: result.backfillNextUid,
			rangeStart: result.rangeStart,
			rangeEnd: result.rangeEnd,
			queuedMore: result.queuedMore,
			uidvalidityChanged: result.uidvalidityChanged,
			processed: result.fetched,
			total:
				result.rangeEnd && result.rangeStart
					? result.rangeEnd - result.rangeStart + 1
					: result.fetched,
		},
	});

	if (result.fetched > 0) {
		await queueAccountBacklog(job.scope_id);
	}
}

async function syncAccountReconcileJob(job: JobRecord, trace?: LogTrace) {
	const { runReconcile } = await import("#/lib/sync");
	const result = await runReconcile(
		job.scope_id,
		trace?.child({
			kind: "sync",
			operation: "sync_account_reconcile",
			job_id: job.id,
			job_kind: job.kind,
			account_id: job.scope_id,
		}),
	);
	await completeJob({
		id: job.id,
		successCount: result.tombstoned,
		errorCount: 0,
		meta: {
			mode: "live",
			tombstoned: result.tombstoned,
		},
	});
}

async function classifyAccountBacklogJob(job: JobRecord, trace: LogTrace) {
	const backlogTrace = trace.child({
		kind: "worker",
		operation: "classify_account_backlog",
		job_id: job.id,
		job_kind: job.kind,
		account_id: job.scope_id,
	});
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", job.scope_id)
		.executeTakeFirstOrThrow();

	const messages = await db
		.selectFrom("messages")
		.leftJoin("message_labels", "message_labels.message_id", "messages.id")
		.select([
			"messages.id",
			"messages.received_at",
			"messages.sender_address",
			"messages.subject",
			"messages.body_text_normalized",
			"messages.content_sha256",
			"message_labels.content_sha256 as label_sha256",
		])
		.where("messages.account_id", "=", job.scope_id)
		.where((eb) =>
			eb.or([
				eb("message_labels.message_id", "is", null),
				eb(
					"message_labels.content_sha256",
					"!=",
					eb.ref("messages.content_sha256"),
				),
			]),
		)
		.execute();

	backlogTrace.add({
		total: messages.length,
	});

	if (messages.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: { processed: 0, total: 0, mode: "live" },
		});
		backlogTrace.complete("worker.classify_backlog.complete", {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	const overseerCtx = await loadLatestOverseerContext(account.id);
	const allowedTags = mergeAllowedTags(overseerCtx.promotedTags);
	const attachmentRows = await db
		.selectFrom("attachments")
		.innerJoin("messages", "messages.id", "attachments.message_id")
		.select([
			"attachments.message_id",
			"attachments.filename",
			"attachments.mime_type",
		])
		.where("messages.account_id", "=", job.scope_id)
		.execute();

	const attachmentsByMessage = new Map<
		string,
		Array<{ filename: string | null; mime_type: string | null }>
	>();
	for (const row of attachmentRows) {
		const current = attachmentsByMessage.get(row.message_id) ?? [];
		current.push({
			filename: row.filename,
			mime_type: row.mime_type,
		});
		attachmentsByMessage.set(row.message_id, current);
	}

	let successCount = 0;
	let errorCount = 0;

	await updateJob({
		id: job.id,
		requestCount: messages.length,
		model: APP_CONFIG.classifierModel,
		promptVersion: CLASSIFY_PROMPT_VERSION,
		meta: { mode: "live", processed: 0, total: messages.length },
	});
	backlogTrace.info("worker.classify_backlog.start", {
		total: messages.length,
	});

	await runConcurrent(
		messages,
		async (message) => {
			const moderation = await ensureModerationForMessage({
				jobId: job.id,
				messageId: message.id,
				sender: message.sender_address ?? "(unknown)",
				subject: message.subject ?? "(no subject)",
				bodyText: message.body_text_normalized,
			});

			await classifyMessageNow({
				jobId: job.id,
				messageId: message.id,
				accountLabel: account.label,
				sender: message.sender_address ?? "(unknown)",
				subject: message.subject ?? "(no subject)",
				receivedAt: message.received_at ?? "(unknown)",
				bodyText: message.body_text_normalized,
				attachmentsSummary: buildAttachmentSummary(
					attachmentsByMessage.get(message.id) ?? [],
				),
				moderationFlag: moderation.nsfwFlag,
				moderationScores: topModerationScores(moderation.scores),
				promptPreamble: overseerCtx.promptPreamble,
				allowedTags,
			});
		},
		async (_message, error) => {
			if (error) {
				errorCount += 1;
			} else {
				successCount += 1;
			}
			await updateJob({
				id: job.id,
				successCount,
				errorCount,
				meta: {
					mode: "live",
					processed: successCount + errorCount,
					total: messages.length,
				},
			});
			const processed = successCount + errorCount;
			if (processed % 25 === 0 || processed === messages.length) {
				backlogTrace.info("worker.classify_backlog.progress", {
					processed,
					success_count: successCount,
					error_count: errorCount,
					total: messages.length,
				});
			}
		},
	);

	await completeJob({
		id: job.id,
		successCount,
		errorCount,
		meta: {
			mode: "live",
			processed: successCount + errorCount,
			total: messages.length,
		},
	});
	backlogTrace.complete("worker.classify_backlog.complete", {
		processed: successCount + errorCount,
		success_count: successCount,
		error_count: errorCount,
		total: messages.length,
	});

	if (await maybeQueueOverseerForAccount(account.id)) {
		await queueJobIdempotent({
			kind: "rebuild_overseer",
			scopeType: "account",
			scopeId: account.id,
			model: APP_CONFIG.fallbackModel,
			promptVersion: OVERSEER_PROMPT_VERSION,
		});
	}
}

async function processJob(job: JobRecord, trace: LogTrace) {
	switch (job.kind) {
		case "rebuild_overseer":
			await rebuildOverseerJob(job, trace);
			return;
		case "sync_account_full":
			await syncAccountFullJob(job, trace);
			return;
		case "sync_account_delta":
			await syncAccountDeltaJob(job, trace);
			return;
		case "sync_account_backfill":
			await syncAccountBackfillJob(job, trace);
			return;
		case "sync_account_reconcile":
			await syncAccountReconcileJob(job, trace);
			return;
		case "classify_account_backlog":
			await classifyAccountBacklogJob(job, trace);
			return;
		default:
			throw new Error(`Unsupported job kind: ${job.kind satisfies never}`);
	}
}

export async function runWorkerIteration(input: { waitOnIdle: boolean }) {
	const job = claimNextJob();
	if (!job) {
		if (input.waitOnIdle) {
			await delay(APP_CONFIG.workerPollMs);
		}
		return false;
	}

	const trace = startTrace({
		kind: "worker",
		operation: "process_job",
		job_id: job.id,
		job_kind: job.kind,
		scope_type: job.scope_type,
		scope_id: job.scope_id,
		account_id: job.scope_type === "account" ? job.scope_id : undefined,
	});
	trace.info("worker.job_start");
	const heartbeat = setInterval(() => {
		void extendJobLease(job.id);
	}, APP_CONFIG.liveHeartbeatMs);

	try {
		await processJob(job, trace);
		trace.complete("worker.job_complete");
	} catch (error) {
		trace.fail("worker.job_fail", error);
		await failJob(job.id, error);
	} finally {
		clearInterval(heartbeat);
	}

	return true;
}

async function workerLoop() {
	const workerTrace = startTrace({
		kind: "worker",
		operation: "worker_loop",
	});
	workerTrace.info("worker.start");
	runMigrations();
	requeueExpiredJobs();

	try {
		const { restoreWatchers } = await import("#/lib/watchers");
		await restoreWatchers();
		workerTrace.complete("worker.restore_watchers");
	} catch (error) {
		workerTrace.fail("worker.restore_watchers_failed", error);
	}

	while (true) {
		await runWorkerIteration({ waitOnIdle: true });
	}
}

export function ensureWorkerStarted() {
	if (!APP_CONFIG.runWorker) {
		return;
	}

	if (globalThis.__zmailWorkerStarted__) {
		return;
	}

	globalThis.__zmailWorkerStarted__ = true;
	globalThis.__zmailWorkerLoop__ = workerLoop();
}

export async function drainWorkerUntilIdle() {
	const trace = startTrace({
		kind: "worker",
		operation: "drain_worker",
	});
	trace.info("worker.drain.start");
	runMigrations();
	requeueExpiredJobs();

	while (await runWorkerIteration({ waitOnIdle: false })) {
		// Drain until no queued or expired jobs remain.
	}
	trace.complete("worker.drain.complete");
}
