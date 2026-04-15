import {
	buildAttachmentSummary,
	classifyMessageNow,
	mergeAllowedTags,
} from "#/lib/classify";
import {
	APP_CONFIG,
	CLASSIFY_PROMPT_VERSION,
	FINANCE_INTEL_PROMPT_VERSION,
	FINANCE_KNOWLEDGE_PROMPT_VERSION,
	OVERSEER_PROMPT_VERSION,
} from "#/lib/config";
import { getDb, runMigrations, safeJsonParse } from "#/lib/db";
import {
	claimNextJob,
	completeJob,
	extendJobLease,
	failJob,
	findOpenJob,
	type JobRecord,
	parseJobMeta,
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
import { normalizeMessageLabel } from "#/lib/schemas";

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

async function importOperatorRegistryJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "import_operator_registry",
		job_id: job.id,
		job_kind: job.kind,
	});
	const [{ importOperatorRegistry }, { getDb }] = await Promise.all([
		import("#/lib/registry"),
		import("#/lib/db"),
	]);
	const result = await importOperatorRegistry();
	const db = getDb();
	const accounts = await db.selectFrom("accounts").select(["id"]).execute();
	for (const account of accounts) {
		await queueAccountFinanceBacklog(account.id);
	}
	await completeJob({
		id: job.id,
		successCount:
			result.counts.identities +
			result.counts.institutions +
			result.counts.financialAccounts +
			result.counts.senderRules,
		errorCount: 0,
		meta: {
			mode: "live",
			queuedFinanceBacklogs: accounts.length,
			registrySha256: result.sha256,
			importedAt: result.importedAt,
			sourceDir: result.sourceDir,
			...result.counts,
		},
	});
	jobTrace.complete("worker.import_operator_registry.complete", {
		registry_sha256: result.sha256,
		queued_finance_backlogs: accounts.length,
	});
}

async function rebuildFinanceKnowledgeJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "rebuild_finance_knowledge",
		job_id: job.id,
		job_kind: job.kind,
	});
	const { rebuildFinanceKnowledge } = await import("#/lib/finance-knowledge");
	const result = await rebuildFinanceKnowledge();
	await completeJob({
		id: job.id,
		successCount: result.events + result.documents,
		errorCount: 0,
		meta: {
			mode: "live",
			events: result.events,
			documents: result.documents,
			evidence: result.evidence,
		},
	});
	jobTrace.complete("worker.rebuild_finance_knowledge.complete", {
		events: result.events,
		documents: result.documents,
		evidence: result.evidence,
	});
	await queueFinanceRollupsRebuild();
}

async function rebuildFinanceRollupsJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "rebuild_finance_rollups",
		job_id: job.id,
		job_kind: job.kind,
	});
	const { rebuildFinanceRollups } = await import("#/lib/finance-rollups");
	const result = await rebuildFinanceRollups();
	await completeJob({
		id: job.id,
		successCount: result.rollups + result.subcategoryRollups,
		errorCount: 0,
		meta: {
			mode: "live",
			years: result.years,
			rollups: result.rollups,
			subcategoryRollups: result.subcategoryRollups,
		},
	});
	jobTrace.complete("worker.rebuild_finance_rollups.complete", {
		years: result.years,
		rollups: result.rollups,
		subcategory_rollups: result.subcategoryRollups,
	});
}

async function reconcileRegistrySuggestionsJob(
	job: JobRecord,
	trace: LogTrace,
) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "reconcile_registry_suggestions",
		job_id: job.id,
		job_kind: job.kind,
	});
	const { reconcileRegistrySuggestions } = await import("#/lib/registry");
	const result = await reconcileRegistrySuggestions();
	await completeJob({
		id: job.id,
		successCount: result.applied,
		errorCount: 0,
		meta: {
			mode: "live",
			applied: result.applied,
			pending: result.pending,
			superseded: result.superseded,
		},
	});
	jobTrace.complete("worker.reconcile_registry_suggestions.complete", {
		applied: result.applied,
		pending: result.pending,
		superseded: result.superseded,
	});
	if (result.applied > 0) {
		const db = getDb();
		const accounts = await db.selectFrom("accounts").select(["id"]).execute();
		for (const account of accounts) {
			await queueAccountFinanceBacklog(account.id);
		}
		await queueFinanceRollupsRebuild();
	}
}

async function rebuildCategoryAssignmentsJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "rebuild_category_assignments",
		job_id: job.id,
		job_kind: job.kind,
	});
	const { rebuildMessageCategoryAssignments } = await import(
		"#/lib/category-rules"
	);
	const result = await rebuildMessageCategoryAssignments();
	await completeJob({
		id: job.id,
		successCount: result.projected,
		errorCount: 0,
		meta: {
			mode: "live",
			projected: result.projected,
		},
	});
	jobTrace.complete("worker.rebuild_category_assignments.complete", {
		projected: result.projected,
	});
}

async function importFinanceArtifactJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "import_finance_artifact",
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta(job, { artifact: null as unknown });
	const { importFinanceArtifact } = await import("#/lib/finance-imports");
	const result = await importFinanceArtifact(meta.artifact);
	await completeJob({
		id: job.id,
		successCount: result.documents + result.transactions,
		errorCount: 0,
		meta: {
			mode: "live",
			importRunId: result.importRunId,
			documents: result.documents,
			transactions: result.transactions,
			registrySuggestions: result.registrySuggestions,
		},
	});
	jobTrace.complete("worker.import_finance_artifact.complete", {
		import_run_id: result.importRunId,
		documents: result.documents,
		transactions: result.transactions,
		registry_suggestions: result.registrySuggestions,
	});
	await queueRegistrySuggestionReconcile();
	await queueFinanceRollupsRebuild();
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

async function queueAccountFinanceBacklog(accountId: string) {
	await queueJobIdempotent({
		kind: "classify_finance_backlog",
		scopeType: "account",
		scopeId: accountId,
		model: APP_CONFIG.classifierModel,
		promptVersion: FINANCE_INTEL_PROMPT_VERSION,
	});
}

async function queueFinanceKnowledgeRebuild() {
	await queueJobIdempotent({
		kind: "rebuild_finance_knowledge",
		scopeType: "system",
		scopeId: "finance",
		model: APP_CONFIG.fallbackModel,
		promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
	});
}

async function queueFinanceRollupsRebuild() {
	await queueJobIdempotent({
		kind: "rebuild_finance_rollups",
		scopeType: "system",
		scopeId: "finance_rollups",
		model: APP_CONFIG.fallbackModel,
		promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
	});
}

async function queueRegistrySuggestionReconcile() {
	await queueJobIdempotent({
		kind: "reconcile_registry_suggestions",
		scopeType: "system",
		scopeId: "registry_suggestions",
		model: APP_CONFIG.fallbackModel,
		promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
	});
}

async function queuePendingBackfills(trace?: LogTrace) {
	const db = getDb();
	const candidates = await db
		.selectFrom("account_sync_state")
		.innerJoin("accounts", "accounts.id", "account_sync_state.account_id")
		.select([
			"account_sync_state.account_id",
			"account_sync_state.backfill_next_uid",
		])
		.where("accounts.sync_enabled", "=", 1)
		.where("account_sync_state.backfill_next_uid", "is not", null)
		.where("account_sync_state.last_bootstrap_completed_at", "is not", null)
		.execute();

	let resumed = 0;
	for (const candidate of candidates) {
		const [openFullSync, openBackfill] = await Promise.all([
			findOpenJob({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: candidate.account_id,
			}),
			findOpenJob({
				kind: "sync_account_backfill",
				scopeType: "account",
				scopeId: candidate.account_id,
			}),
		]);
		if (openFullSync || openBackfill) {
			continue;
		}

		await queueJobIdempotent({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: candidate.account_id,
		});
		resumed += 1;
	}

	trace?.info("worker.backfill_resume_scan", {
		candidates: candidates.length,
		resumed,
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

	if (
		!result.skipped &&
		!result.uidvalidityChanged &&
		result.backfillNextUid !== null
	) {
		await queueJobIdempotent({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: job.scope_id,
		});
	}

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
			"message_labels.schema_version as label_schema_version",
		])
		.where("messages.account_id", "=", job.scope_id)
		.where((eb) =>
			eb.or([
				eb("message_labels.message_id", "is", null),
				eb("message_labels.schema_version", "!=", "message-label.v2"),
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

	if (successCount > 0) {
		await queueAccountFinanceBacklog(account.id);
	}
}

async function classifyFinanceBacklogJob(job: JobRecord, trace: LogTrace) {
	const backlogTrace = trace.child({
		kind: "worker",
		operation: "classify_finance_backlog",
		job_id: job.id,
		job_kind: job.kind,
		account_id: job.scope_id,
	});
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.select(["id", "label", "email_address"])
		.where("id", "=", job.scope_id)
		.executeTakeFirstOrThrow();

	const rows = await db
		.selectFrom("messages")
		.innerJoin("message_labels", "message_labels.message_id", "messages.id")
		.select([
			"messages.id",
			"messages.content_sha256",
			"messages.parse_status",
			"messages.received_at",
			"messages.sender_address",
			"messages.subject",
			"messages.body_text_normalized",
			"message_labels.label_json",
		])
		.where("messages.account_id", "=", job.scope_id)
		.execute();

	const rootFinanceRows = rows.flatMap((row) => {
		const rootLabel = normalizeMessageLabel(
			safeJsonParse(row.label_json, null),
		);
		if (!rootLabel?.finance?.relevant) {
			return [];
		}
		return [
			{
				...row,
				rootLabel,
			},
		];
	});

	if (rootFinanceRows.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: { mode: "live", processed: 0, total: 0 },
		});
		backlogTrace.complete("worker.classify_finance_backlog.complete", {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	const [
		{ loadOperatorRegistry, matchRegistryForMessage },
		{ classifyFinanceMessageNow },
		{ isSecondaryHeadCurrent, persistSecondaryResult },
	] = await Promise.all([
		import("#/lib/registry"),
		import("#/lib/finance-intel"),
		import("#/lib/secondary"),
	]);
	const registry = await loadOperatorRegistry();
	const messageIds = rootFinanceRows.map((row) => row.id);
	const [heads, attachmentRows] = await Promise.all([
		db
			.selectFrom("message_secondary_heads")
			.leftJoin(
				"message_secondary_results",
				"message_secondary_results.id",
				"message_secondary_heads.secondary_result_id",
			)
			.selectAll("message_secondary_heads")
			.select(
				"message_secondary_results.schema_version as result_schema_version",
			)
			.where("message_secondary_heads.classifier_key", "=", "finance_intel")
			.where("message_secondary_heads.message_id", "in", messageIds)
			.execute(),
		db
			.selectFrom("attachments")
			.select(["message_id", "filename", "mime_type"])
			.where("message_id", "in", messageIds)
			.execute(),
	]);

	const headsByMessage = new Map(heads.map((head) => [head.message_id, head]));
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

	const workItems = rootFinanceRows.filter((row) => {
		const head = headsByMessage.get(row.id);
		if (row.parse_status === "error") {
			return (
				!head ||
				head.status !== "blocked_parse_error" ||
				head.content_sha256 !== row.content_sha256 ||
				head.registry_sha256 !== registry.sha256
			);
		}

		return (
			head?.result_schema_version !== "finance-intel.v2" ||
			!isSecondaryHeadCurrent(head, {
				contentSha256: row.content_sha256,
				registrySha256: registry.sha256,
			})
		);
	});

	backlogTrace.add({
		total: workItems.length,
	});

	if (workItems.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: {
				mode: "live",
				processed: 0,
				total: 0,
				registrySha256: registry.sha256,
			},
		});
		backlogTrace.complete("worker.classify_finance_backlog.complete", {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	let successCount = 0;
	let errorCount = 0;

	await updateJob({
		id: job.id,
		requestCount: workItems.length,
		model: APP_CONFIG.classifierModel,
		promptVersion: FINANCE_INTEL_PROMPT_VERSION,
		meta: {
			mode: "live",
			processed: 0,
			total: workItems.length,
			registrySha256: registry.sha256,
		},
	});
	backlogTrace.info("worker.classify_finance_backlog.start", {
		total: workItems.length,
		registry_sha256: registry.sha256,
	});

	await runConcurrent(
		workItems,
		async (row) => {
			if (row.parse_status === "error") {
				await persistSecondaryResult({
					jobId: job.id,
					messageId: row.id,
					classifierKey: "finance_intel",
					schemaVersion: "finance-intel.v2",
					model: "system",
					backend: "system",
					promptVersion: FINANCE_INTEL_PROMPT_VERSION,
					source: "system",
					rawResponse: {
						reason: "parse_error",
						parseStatus: row.parse_status,
					},
					usage: null,
					result: {
						schemaVersion: "finance-intel.v2",
						messageKind: "other_finance",
						actionability: "manual_review",
						transactionCandidates: [],
						documentCandidates: [],
						matchedRegistryRefs: {
							identityIds: [],
							institutionIds: [],
							financialAccountIds: [],
						},
						unresolvedEntityHints: {
							identityHints: [],
							institutionHints: [],
							financialAccountHints: [],
						},
						confidence: {
							overall: 1,
							messageKind: 1,
							transactionExtraction: 1,
							registryMatching: 1,
						},
						explanation: "Blocked by parse error.",
					},
					status: "blocked_parse_error",
					overallConfidence: 1,
					contentSha256: row.content_sha256,
					registrySha256: registry.sha256,
				});
				return;
			}

			const registryMatches = await matchRegistryForMessage({
				accountLabel: account.label,
				accountEmail: account.email_address,
				senderAddress: row.sender_address,
				subject: row.subject,
				bodyText: row.body_text_normalized,
				rootLabel: row.rootLabel,
			});

			await classifyFinanceMessageNow({
				jobId: job.id,
				messageId: row.id,
				accountLabel: account.label,
				accountEmail: account.email_address,
				sender: row.sender_address ?? "(unknown)",
				subject: row.subject ?? "(no subject)",
				receivedAt: row.received_at ?? "(unknown)",
				bodyText: row.body_text_normalized,
				attachmentsSummary: buildAttachmentSummary(
					attachmentsByMessage.get(row.id) ?? [],
				),
				rootLabel: row.rootLabel,
				registryMatches,
				contentSha256: row.content_sha256,
			});
		},
		async (_row, error) => {
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
					total: workItems.length,
					registrySha256: registry.sha256,
				},
			});
		},
	);

	await completeJob({
		id: job.id,
		successCount,
		errorCount,
		meta: {
			mode: "live",
			processed: successCount + errorCount,
			total: workItems.length,
			registrySha256: registry.sha256,
		},
	});
	backlogTrace.complete("worker.classify_finance_backlog.complete", {
		processed: successCount + errorCount,
		success_count: successCount,
		error_count: errorCount,
		total: workItems.length,
	});

	if (successCount > 0) {
		await queueFinanceKnowledgeRebuild();
		await queueFinanceRollupsRebuild();
	}
}

async function processJob(job: JobRecord, trace: LogTrace) {
	switch (job.kind) {
		case "rebuild_overseer":
			await rebuildOverseerJob(job, trace);
			return;
		case "rebuild_finance_knowledge":
			await rebuildFinanceKnowledgeJob(job, trace);
			return;
		case "rebuild_finance_rollups":
			await rebuildFinanceRollupsJob(job, trace);
			return;
		case "rebuild_category_assignments":
			await rebuildCategoryAssignmentsJob(job, trace);
			return;
		case "import_operator_registry":
			await importOperatorRegistryJob(job, trace);
			return;
		case "import_finance_artifact":
			await importFinanceArtifactJob(job, trace);
			return;
		case "reconcile_registry_suggestions":
			await reconcileRegistrySuggestionsJob(job, trace);
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
		case "classify_finance_backlog":
			await classifyFinanceBacklogJob(job, trace);
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

	await queuePendingBackfills(workerTrace);

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
	globalThis.__zmailWorkerLoop__ = workerLoop().catch((error) => {
		globalThis.__zmailWorkerStarted__ = false;
		globalThis.__zmailWorkerLoop__ = undefined;
		startTrace({
			kind: "worker",
			operation: "worker_loop_crash",
		}).fail("worker.loop_crashed", error);
	});
}

export async function drainWorkerUntilIdle() {
	const trace = startTrace({
		kind: "worker",
		operation: "drain_worker",
	});
	trace.info("worker.drain.start");
	runMigrations();
	requeueExpiredJobs();
	await queuePendingBackfills(trace);

	while (await runWorkerIteration({ waitOnIdle: false })) {
		// Drain until no queued or expired jobs remain.
	}
	trace.complete("worker.drain.complete");
}
