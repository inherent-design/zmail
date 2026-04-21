import { sql } from "kysely";

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
	MODERATION_PROMPT_VERSION,
	OVERSEER_PROMPT_VERSION,
	REVIEW_CLASSIFIER_PROMPT_VERSION,
} from "#/lib/config";
import {
	ensureAccountOwnershipBackfill,
	getDb,
	runMigrations,
	safeJsonParse,
} from "#/lib/db";
import {
	claimNextJob,
	completeJob,
	extendJobLease,
	failJob,
	findOpenJob,
	type JobKind,
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
import { recordJobComplete } from "#/lib/observability";
import {
	buildOverseerProfile,
	loadLatestOverseerContext,
	maybeQueueOverseerForAccount,
} from "#/lib/overseer";
import { promptSha256ForName } from "#/lib/prompt-identity";
import {
	currentOrgId,
	defaultOrgId,
	discoverOrgRuntimeIds,
	runWithOrgContext,
} from "#/lib/runtime";
import { publishActionEvent } from "#/lib/runtime-events";
import { parseCurrentMessageLabel } from "#/lib/schemas";

declare global {
	var __zmailWorkerStarted__: boolean | undefined;
	var __zmailWorkerLoop__: Promise<void> | undefined;
	var __zmailOrgWorkerLoops__: Map<string, Promise<void>> | undefined;
}

const ROOT_BACKLOG_BATCH_SIZE = 250;
const FINANCE_BACKLOG_BATCH_SIZE = 100;

function orgWorkerLoops() {
	if (!globalThis.__zmailOrgWorkerLoops__) {
		globalThis.__zmailOrgWorkerLoops__ = new Map();
	}
	return globalThis.__zmailOrgWorkerLoops__;
}

function discoverWorkerOrgIds(seedOrgId?: string) {
	const orgIds = new Set(discoverOrgRuntimeIds());
	if (seedOrgId) {
		orgIds.add(seedOrgId);
	}
	if (orgIds.size === 0) {
		orgIds.add(defaultOrgId());
	}
	return [...orgIds].sort();
}

function refreshLegacyWorkerLoop() {
	globalThis.__zmailWorkerLoop__ = orgWorkerLoops().values().next().value;
}

function moderationPromptVersionSql() {
	return sql<string | null>`case
		when moderation_results.raw_response_json is not null
			and json_valid(moderation_results.raw_response_json)
		then json_extract(moderation_results.raw_response_json, '$.promptVersion')
		else null
	end`;
}

function staleModerationPromptSql() {
	return sql<boolean>`coalesce(${moderationPromptVersionSql()}, '') != ${MODERATION_PROMPT_VERSION}`;
}

function staleRootPromptSql(promptSha256: string) {
	return sql<boolean>`message_labels.source != 'manual'
		and (
			coalesce(classification_results.prompt_version, '') != ${CLASSIFY_PROMPT_VERSION}
			or coalesce(classification_results.prompt_sha256, '') != ${promptSha256}
		)`;
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

export function createJobProgressSink(
	job: JobRecord,
	phase: "full" | "delta" | "backfill",
) {
	return {
		async onProgress(input: {
			phase: "full" | "delta" | "backfill";
			fetched: number;
			total: number | null;
			rangeStart?: number | null;
			rangeEnd?: number | null;
			backfillNextUid?: number | null;
		}) {
			const updatedAt = new Date().toISOString();
			const total = input.total;
			const processed = Math.max(0, input.fetched);
			let etaSeconds: number | null = null;
			if (total !== null && total > 0 && job.started_at) {
				const elapsedSeconds = Math.max(
					0,
					(Date.now() - new Date(job.started_at).getTime()) / 1000,
				);
				const ratePerSecond =
					elapsedSeconds > 0 && processed > 0
						? processed / elapsedSeconds
						: null;
				etaSeconds =
					ratePerSecond && ratePerSecond > 0
						? Math.max(0, (total - processed) / ratePerSecond)
						: null;
			}
			await extendJobLease(job.id);
			await updateJob({
				id: job.id,
				meta: {
					mode: "live",
					phase: input.phase ?? phase,
					fetched: input.fetched,
					processed,
					total,
					rangeStart: input.rangeStart ?? null,
					rangeEnd: input.rangeEnd ?? null,
					backfillNextUid: input.backfillNextUid ?? null,
					etaSeconds,
					updatedAt,
				},
			});
		},
	};
}

function buildProgressMeta(
	job: Pick<JobRecord, "started_at">,
	input: {
		processed: number;
		total: number;
		extra?: Record<string, unknown>;
	},
) {
	const updatedAt = new Date().toISOString();
	const processed = Math.max(0, input.processed);
	const total = Math.max(0, input.total);
	let etaSeconds: number | null = null;
	if (total === 0 || processed >= total) {
		etaSeconds = 0;
	} else if (processed > 0 && job.started_at) {
		const elapsedSeconds = Math.max(
			0,
			(Date.now() - new Date(job.started_at).getTime()) / 1000,
		);
		const ratePerSecond =
			elapsedSeconds > 0 ? processed / elapsedSeconds : null;
		etaSeconds =
			ratePerSecond && ratePerSecond > 0
				? Math.max(0, (total - processed) / ratePerSecond)
				: null;
	}
	return {
		mode: "live",
		processed,
		total,
		etaSeconds,
		updatedAt,
		...(input.extra ?? {}),
	};
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

async function loadMaterializeInputWatermark() {
	const db = getDb();
	const [headState, reviewCreatedState, reviewResolvedState, findingState] =
		await Promise.all([
			db
				.selectFrom("message_secondary_heads")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.where("classifier_key", "=", "finance_intel")
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("reviews")
				.select((eb) => eb.fn.max("created_at").as("created_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("reviews")
				.select((eb) => eb.fn.max("resolved_at").as("resolved_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("review_classification_heads")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.executeTakeFirstOrThrow(),
		]);
	return maxIsoValue([
		headState.updated_at ?? null,
		reviewCreatedState.created_at ?? null,
		reviewResolvedState.resolved_at ?? null,
		findingState.updated_at ?? null,
	]);
}

async function rebuildFinanceKnowledgeJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "rebuild_finance_knowledge",
		job_id: job.id,
		job_kind: job.kind,
	});
	const inputWatermark = await loadMaterializeInputWatermark();
	const { rebuildFinanceKnowledge } = await import("#/lib/finance-knowledge");
	const result = await rebuildFinanceKnowledge();
	const outputWatermark = await loadMaterializeInputWatermark();
	const requeuedForChangedInputs = Boolean(
		inputWatermark && outputWatermark && outputWatermark > inputWatermark,
	);
	await completeJob({
		id: job.id,
		successCount: result.events + result.documents,
		errorCount: 0,
		meta: {
			mode: "live",
			events: result.events,
			documents: result.documents,
			evidence: result.evidence,
			inputWatermark,
			outputWatermark,
			requeuedForChangedInputs,
		},
	});
	jobTrace.complete("worker.rebuild_finance_knowledge.complete", {
		events: result.events,
		documents: result.documents,
		evidence: result.evidence,
	});
	if (requeuedForChangedInputs) {
		await queueFinanceKnowledgeRebuild();
	}
	await publishActionEvent({
		topic: "finance",
		eventType: "finance.ledger_rebuilt",
		entityKind: "job",
		entityId: job.id,
		payload: {
			...result,
			changeHints: {
				islands: [
					"finance.summary",
					"finance.cashflow",
					"finance.categories",
					"finance.overview.rollups",
					"finance.lanes",
				],
			},
		},
	});
	await queueFinanceRollupsRebuild();
	if (await hasUnresolvedFinanceLedgerRows()) {
		await queueFinanceMappingCandidatesGeneration({
			year: null,
			source: "finance_knowledge_snapshot",
			inputWatermark,
			outputWatermark,
		});
	}
}

async function rebuildFinanceRollupsJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "rebuild_finance_rollups",
		job_id: job.id,
		job_kind: job.kind,
	});
	const inputWatermark = await loadMaterializeInputWatermark();
	const { rebuildFinanceRollups } = await import("#/lib/finance-rollups");
	const result = await rebuildFinanceRollups();
	const outputWatermark = await loadMaterializeInputWatermark();
	const requeuedForChangedInputs = Boolean(
		inputWatermark && outputWatermark && outputWatermark > inputWatermark,
	);
	await completeJob({
		id: job.id,
		successCount: result.rollups + result.subcategoryRollups,
		errorCount: 0,
		meta: {
			mode: "live",
			years: result.years,
			rollups: result.rollups,
			subcategoryRollups: result.subcategoryRollups,
			inputWatermark,
			outputWatermark,
			requeuedForChangedInputs,
		},
	});
	jobTrace.complete("worker.rebuild_finance_rollups.complete", {
		years: result.years,
		rollups: result.rollups,
		subcategory_rollups: result.subcategoryRollups,
	});
	if (requeuedForChangedInputs) {
		await queueFinanceRollupsRebuild();
	}
	await publishActionEvent({
		topic: "finance",
		eventType: "finance.patterns_rebuilt",
		entityKind: "job",
		entityId: job.id,
		payload: {
			...result,
			changeHints: {
				islands: ["finance.subscriptions", "finance.summary", "finance.lanes"],
			},
		},
	});
}

async function exportFinanceBeancountJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "export_finance_beancount",
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta<{
		orgId?: string;
		outDir?: string;
		exportRunId?: string;
		year?: number | null;
		strict?: boolean;
		force?: boolean;
	}>(job, {});
	if (!meta.outDir) {
		throw new Error("export_finance_beancount job missing outDir");
	}
	await publishActionEvent({
		topic: "finance",
		eventType: "finance.export_started",
		entityKind: "job",
		entityId: job.id,
		payload: {
			...meta,
			changeHints: {
				islands: ["finance.export-health", "finance.lanes"],
			},
		},
	});
	try {
		const { exportFinanceBeancountPackage } = await import(
			"#/lib/beancount-export"
		);
		const result = await exportFinanceBeancountPackage({
			orgId: meta.orgId ?? currentOrgId(),
			outDir: meta.outDir,
			exportRunId: meta.exportRunId,
			year: meta.year ?? undefined,
			strict: meta.strict ?? true,
			force: meta.force ?? false,
		});
		await completeJob({
			id: job.id,
			successCount: result.exported,
			errorCount: 0,
			meta: {
				mode: "live",
				...result,
			},
		});
		await publishActionEvent({
			topic: "finance",
			eventType:
				result.validation.beanCheck === "failed"
					? "finance.export_failed"
					: "finance.export_completed",
			entityKind: "finance_export_run",
			entityId: result.exportRunId,
			payload: {
				...result,
				changeHints: {
					islands: ["finance.export-health", "finance.lanes"],
				},
			},
		});
		jobTrace.complete("worker.export_finance_beancount.complete", {
			export_run_id: result.exportRunId,
			exported: result.exported,
			unresolved: result.unresolved,
			validation: result.validation.beanCheck,
		});
	} catch (error) {
		await publishActionEvent({
			topic: "finance",
			eventType: "finance.export_failed",
			entityKind: "job",
			entityId: job.id,
			payload: {
				...meta,
				error: error instanceof Error ? error.message : String(error),
				changeHints: {
					islands: ["finance.export-health", "finance.lanes"],
				},
			},
		});
		throw error;
	}
}

async function generateTaxReportJob(job: JobRecord, trace: LogTrace) {
	const operation =
		job.kind === "generate_tax_business_quarter_package"
			? "generate_tax_business_quarter_package"
			: "generate_tax_personal_package";
	const jobTrace = trace.child({
		kind: "worker",
		operation,
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta<{
		year?: number;
		quarter?: number | null;
		businessSlug?: string | null;
		outDir?: string | null;
		reportRunId?: string;
	}>(job, {});
	if (!meta.year) {
		throw new Error(`${job.kind} job missing year`);
	}
	const { generateTaxReportPackage } = await import("#/lib/tax-reporting");
	const result = await generateTaxReportPackage({
		reportRunId: meta.reportRunId ?? job.scope_id,
		reportKind:
			job.kind === "generate_tax_business_quarter_package"
				? "business_quarter"
				: "personal_annual",
		year: meta.year,
		quarter: meta.quarter ?? null,
		businessSlug: meta.businessSlug ?? null,
		outDir: meta.outDir ?? null,
	});
	await completeJob({
		id: job.id,
		successCount: result.acceptedRows,
		errorCount: 0,
		meta: {
			mode: "live",
			processed: result.acceptedRows + result.reviewRows,
			total: result.acceptedRows + result.reviewRows,
			reportRunId: result.reportRunId,
			status: result.status,
			outDir: result.outDir,
			acceptedRows: result.acceptedRows,
			reviewRows: result.reviewRows,
		},
	});
	jobTrace.complete(`worker.${operation}.complete`, {
		report_run_id: result.reportRunId,
		status: result.status,
		accepted_rows: result.acceptedRows,
		review_rows: result.reviewRows,
	});
	await publishActionEvent({
		topic: "finance",
		eventType: "finance.tax_report_completed",
		entityKind: "tax_report_run",
		entityId: result.reportRunId,
		payload: {
			...result,
			changeHints: {
				islands: ["finance.tax", "finance.export-health", "finance.lanes"],
			},
		},
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

async function generateFinanceMappingCandidatesJob(
	job: JobRecord,
	trace: LogTrace,
) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "generate_finance_mapping_candidates",
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta<{
		year?: number | null;
		source?: string | null;
	}>(job, {});
	const {
		generateFinanceMappingCandidates,
		loadFinanceMappingCandidateInputWatermark,
	} = await import("#/lib/finance-mapping-candidates");
	const inputWatermark = await loadFinanceMappingCandidateInputWatermark();
	const result = await generateFinanceMappingCandidates({
		year: meta.year ?? null,
	});
	const outputWatermark = await loadFinanceMappingCandidateInputWatermark();
	const requeuedForChangedInputs = Boolean(
		outputWatermark && (!inputWatermark || outputWatermark > inputWatermark),
	);
	await completeJob({
		id: job.id,
		successCount: result.suggestions,
		errorCount: 0,
		meta: {
			mode: "live",
			processed: result.ledgerRows,
			total: result.ledgerRows,
			...result,
			inputWatermark,
			outputWatermark,
			requeuedForChangedInputs,
			source: meta.source ?? null,
		},
	});
	jobTrace.complete("worker.generate_finance_mapping_candidates.complete", {
		ledger_rows: result.ledgerRows,
		clusters: result.clusters,
		suggestions: result.suggestions,
	});
	if (requeuedForChangedInputs) {
		await queueFinanceMappingCandidatesGeneration({
			year: meta.year ?? null,
			source: "mapping_inputs_changed",
			inputWatermark,
			outputWatermark,
		});
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
	const { listPendingMessageCategoryAssignmentIds } = await import(
		"#/lib/category-rules"
	);
	if (
		(
			await listPendingMessageCategoryAssignmentIds({
				limit: 1,
			})
		).length > 0
	) {
		await queueCategoryAssignmentsRebuild();
	}
}

async function importFinanceArtifactJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "import_finance_artifact",
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta(job, {
		artifact: null as unknown,
		uploadId: null as string | null,
	});
	const { importFinanceArtifact } = await import("#/lib/finance-imports");
	const result = await importFinanceArtifact(meta.artifact);
	if (meta.uploadId) {
		const { markFinanceUploadImported } = await import("#/lib/finance-upload");
		await markFinanceUploadImported({
			uploadId: meta.uploadId,
			artifactSha256: result.artifactSha256,
			importRunId: result.importRunId,
		});
	}
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
	await queueFinanceKnowledgeRebuild();
}

async function processFinanceUploadJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "process_finance_upload",
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta<{ uploadId?: string }>(job, {});
	const uploadId = meta.uploadId ?? job.scope_id;
	const { processFinanceUpload } = await import("#/lib/finance-upload");
	const result = await processFinanceUpload({ uploadId });
	await completeJob({
		id: job.id,
		successCount: result.status === "extracted" ? 1 : 0,
		errorCount: result.status === "needs_review" ? 1 : 0,
		meta: {
			mode: "live",
			...result,
		},
	});
	jobTrace.complete("worker.process_finance_upload.complete", result);
}

async function classifyReviewBacklogJob(job: JobRecord, trace: LogTrace) {
	const jobTrace = trace.child({
		kind: "worker",
		operation: "classify_review_backlog",
		job_id: job.id,
		job_kind: job.kind,
	});
	const meta = parseJobMeta<{ accountId?: string; limit?: number }>(job, {});
	const { runReviewClassifier } = await import("#/lib/review-classifier");
	const result = await runReviewClassifier({
		jobId: job.id,
		accountId: meta.accountId,
		limit: meta.limit,
	});
	await completeJob({
		id: job.id,
		successCount: result.result.findings.length,
		errorCount: 0,
		meta: {
			mode: "live",
			processed: result.result.findings.length,
			total:
				result.inputCounts.rootReviews + result.inputCounts.financeLedgerRows,
			resultId: result.resultId,
			rootReviews: result.inputCounts.rootReviews,
			financeLedgerRows: result.inputCounts.financeLedgerRows,
			targetedReclassification: result.result.targetedReclassification.length,
		},
	});
	jobTrace.complete("worker.classify_review_backlog.complete", {
		result_id: result.resultId,
		findings: result.result.findings.length,
		root_reviews: result.inputCounts.rootReviews,
		finance_ledger_rows: result.inputCounts.financeLedgerRows,
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

async function queueReviewClassifierBacklog() {
	await queueJobIdempotent({
		kind: "classify_review_backlog",
		scopeType: "system",
		scopeId: "review_classifier",
		model: APP_CONFIG.classifierModel,
		promptVersion: REVIEW_CLASSIFIER_PROMPT_VERSION,
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

async function queueFinanceMappingCandidatesGeneration(meta: {
	year?: number | null;
	source?: string | null;
	inputWatermark?: string | null;
	outputWatermark?: string | null;
}) {
	await queueJobIdempotent({
		kind: "generate_finance_mapping_candidates",
		scopeType: "system",
		scopeId: "finance_mapping_candidates",
		model: APP_CONFIG.fallbackModel,
		promptVersion: "finance-mapping-overseer-v1",
		meta: {
			year: meta.year ?? null,
			source: meta.source ?? null,
			inputWatermark: meta.inputWatermark ?? null,
			outputWatermark: meta.outputWatermark ?? null,
		},
	});
}

async function queueCategoryAssignmentsRebuild() {
	await queueJobIdempotent({
		kind: "rebuild_category_assignments",
		scopeType: "system",
		scopeId: "categories",
		model: APP_CONFIG.fallbackModel,
		promptVersion: CLASSIFY_PROMPT_VERSION,
	});
}

async function countOpenJobs(input: {
	kinds: JobKind[];
	scopeType?: string;
	scopeId?: string;
}) {
	const db = getDb();
	let query = db
		.selectFrom("jobs")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("kind", "in", input.kinds)
		.where("status", "in", ["queued", "running"]);

	if (input.scopeType) {
		query = query.where("scope_type", "=", input.scopeType);
	}
	if (input.scopeId) {
		query = query.where("scope_id", "=", input.scopeId);
	}

	const row = await query.executeTakeFirstOrThrow();
	return Number(row.count);
}

async function hasPendingRootBacklog(accountId: string) {
	const db = getDb();
	const classifyPromptSha256 = promptSha256ForName("classify-email-v3.md");
	const row = await db
		.selectFrom("messages")
		.leftJoin("message_labels", "message_labels.message_id", "messages.id")
		.leftJoin(
			"classification_results",
			"classification_results.id",
			"message_labels.classification_result_id",
		)
		.leftJoin(
			"moderation_results",
			"moderation_results.message_id",
			"messages.id",
		)
		.select(["messages.id"])
		.where("messages.account_id", "=", accountId)
		.where((eb) =>
			eb.or([
				eb("moderation_results.message_id", "is", null),
				staleModerationPromptSql(),
				eb("message_labels.message_id", "is", null),
				eb("message_labels.schema_version", "!=", "message-label.v3"),
				sql<boolean>`coalesce(message_labels.content_sha256, '') != coalesce(messages.content_sha256, '')`,
				staleRootPromptSql(classifyPromptSha256),
			]),
		)
		.orderBy("messages.received_at", "desc")
		.orderBy("messages.id", "desc")
		.limit(1)
		.executeTakeFirst();
	return Boolean(row);
}

async function hasPendingFinanceBacklog(accountId: string) {
	const db = getDb();
	const { loadOperatorRegistry } = await import("#/lib/registry");
	const registry = await loadOperatorRegistry();
	const financePromptSha256 = promptSha256ForName("finance-intel-v3.md");
	const rows = await db
		.selectFrom("messages")
		.innerJoin("message_labels", "message_labels.message_id", "messages.id")
		.leftJoin("message_secondary_heads", (join) =>
			join
				.onRef("message_secondary_heads.message_id", "=", "messages.id")
				.on("message_secondary_heads.classifier_key", "=", "finance_intel"),
		)
		.leftJoin(
			"message_secondary_results",
			"message_secondary_results.id",
			"message_secondary_heads.secondary_result_id",
		)
		.select([
			"messages.content_sha256",
			"message_labels.label_json",
			"message_secondary_heads.status as head_status",
			"message_secondary_heads.content_sha256 as head_content_sha256",
			"message_secondary_heads.registry_sha256 as head_registry_sha256",
			"message_secondary_results.schema_version as result_schema_version",
			"message_secondary_results.prompt_version as result_prompt_version",
			"message_secondary_results.prompt_sha256 as result_prompt_sha256",
		])
		.where("messages.account_id", "=", accountId)
		.orderBy("messages.received_at", "desc")
		.orderBy("messages.id", "desc")
		.execute();

	return rows.some((row) => {
		const rootLabel = parseCurrentMessageLabel(
			safeJsonParse(row.label_json, null),
		);
		if (
			!rootLabel?.finance.relevant ||
			!rootLabel.finance.requiresFinanceIntel
		) {
			return false;
		}
		return (
			!row.head_status ||
			row.head_status === "stale" ||
			row.result_schema_version !== "finance-intel.v3" ||
			row.head_content_sha256 !== row.content_sha256 ||
			row.head_registry_sha256 !== registry.sha256 ||
			row.result_prompt_version !== FINANCE_INTEL_PROMPT_VERSION ||
			row.result_prompt_sha256 !== financePromptSha256
		);
	});
}

async function hasReadyFinanceHeads() {
	const row = await getDb()
		.selectFrom("message_secondary_heads")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("classifier_key", "=", "finance_intel")
		.where("status", "in", ["ready", "review"])
		.executeTakeFirstOrThrow();
	return Number(row.count) > 0;
}

async function hasUnresolvedFinanceLedgerRows() {
	const row = await getDb()
		.selectFrom("finance_ledger_entries")
		.select(["id"])
		.where("status", "in", ["review", "blocked"])
		.limit(1)
		.executeTakeFirst();
	return Boolean(row);
}

function targetMessageIdsForJob(job: JobRecord) {
	const meta = parseJobMeta<{ targetMessageIds?: unknown }>(job, {});
	if (!Array.isArray(meta.targetMessageIds)) {
		return [];
	}
	return Array.from(
		new Set(
			meta.targetMessageIds
				.map((value) => (typeof value === "string" ? value.trim() : ""))
				.filter((value) => value.length > 0),
		),
	);
}

function maxIsoValue(values: Array<string | null>) {
	return values.reduce<string | null>((current, value) => {
		if (!value) {
			return current;
		}
		if (!current || value > current) {
			return value;
		}
		return current;
	}, null);
}

async function hasRollupInputs() {
	const db = getDb();
	const [readyHeads, importTransactions, importDocuments] = await Promise.all([
		db
			.selectFrom("message_secondary_heads")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("classifier_key", "=", "finance_intel")
			.where("status", "in", ["ready", "review"])
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("finance_import_transactions")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("finance_import_documents")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow(),
	]);

	return (
		Number(readyHeads.count) > 0 ||
		Number(importTransactions.count) > 0 ||
		Number(importDocuments.count) > 0
	);
}

async function financeRollupsNeedRebuild() {
	const db = getDb();
	const [rollupState, subcategoryState, headState, importTransactionState] =
		await Promise.all([
			db
				.selectFrom("finance_yearly_rollups")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("finance_yearly_subcategory_rollups")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("message_secondary_heads")
				.select((eb) => eb.fn.max("updated_at").as("updated_at"))
				.where("classifier_key", "=", "finance_intel")
				.where("status", "in", ["ready", "review"])
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("finance_import_transactions")
				.select((eb) => eb.fn.max("created_at").as("created_at"))
				.executeTakeFirstOrThrow(),
		]);

	const latestRollup = maxIsoValue([
		rollupState.updated_at ?? null,
		subcategoryState.updated_at ?? null,
	]);
	const latestInput = maxIsoValue([
		headState.updated_at ?? null,
		importTransactionState.created_at ?? null,
	]);
	return !latestRollup || Boolean(latestInput && latestInput > latestRollup);
}

async function queueStartupReconciliation(trace?: LogTrace) {
	const db = getDb();
	const accounts = await db.selectFrom("accounts").select(["id"]).execute();
	let rootQueued = 0;
	let financeQueued = 0;

	for (const account of accounts) {
		if (await hasPendingRootBacklog(account.id)) {
			await queueAccountBacklog(account.id);
			rootQueued += 1;
		}
		if (await hasPendingFinanceBacklog(account.id)) {
			await queueAccountFinanceBacklog(account.id);
			financeQueued += 1;
		}
	}

	const [{ listPendingMessageCategoryAssignmentIds }, openFinanceBacklogs] =
		await Promise.all([
			import("#/lib/category-rules"),
			countOpenJobs({ kinds: ["classify_finance_backlog"] }),
		]);
	const pendingCategoryAssignments =
		await listPendingMessageCategoryAssignmentIds({ limit: 1 });
	if (pendingCategoryAssignments.length > 0) {
		await queueCategoryAssignmentsRebuild();
	}

	const readyFinanceHeads = await hasReadyFinanceHeads();
	const rollupInputsAvailable = await hasRollupInputs();
	const rollupsNeedRebuild = rollupInputsAvailable
		? await financeRollupsNeedRebuild()
		: false;

	if (openFinanceBacklogs === 0 && readyFinanceHeads) {
		await queueFinanceKnowledgeRebuild();
		if (rollupsNeedRebuild) {
			await queueFinanceRollupsRebuild();
		}
	} else if (openFinanceBacklogs === 0 && rollupsNeedRebuild) {
		await queueFinanceRollupsRebuild();
	}

	trace?.info("worker.startup_reconciliation", {
		accounts: accounts.length,
		root_queued: rootQueued,
		finance_queued: financeQueued,
		pending_category_assignments: pendingCategoryAssignments.length,
		open_finance_backlogs: openFinanceBacklogs,
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
		createJobProgressSink(job, "full"),
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
			etaSeconds: 0,
			updatedAt: new Date().toISOString(),
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
		createJobProgressSink(job, "delta"),
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
			processed: result.fetched,
			total: result.fetched,
			etaSeconds: 0,
			updatedAt: new Date().toISOString(),
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
		createJobProgressSink(job, "backfill"),
	);
	const total =
		result.rangeEnd && result.rangeStart
			? result.rangeEnd - result.rangeStart + 1
			: result.fetched;
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
			total,
			etaSeconds: result.backfillNextUid === null ? 0 : null,
			updatedAt: new Date().toISOString(),
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
	const isTargeted = job.kind === "classify_root_messages";
	const operation = isTargeted
		? "classify_root_messages"
		: "classify_account_backlog";
	const eventOperation = isTargeted ? operation : "classify_backlog";
	const targetMessageIds = isTargeted ? targetMessageIdsForJob(job) : [];
	const backlogTrace = trace.child({
		kind: "worker",
		operation,
		job_id: job.id,
		job_kind: job.kind,
		account_id: job.scope_id,
	});

	if (isTargeted && targetMessageIds.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: buildProgressMeta(job, {
				processed: 0,
				total: 0,
				extra: { targetMessageIds, skipped: [] },
			}),
		});
		backlogTrace.complete(`worker.${eventOperation}.complete`, {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", job.scope_id)
		.executeTakeFirstOrThrow();
	const classifyPromptSha256 = promptSha256ForName("classify-email-v3.md");

	let messagesQuery = db
		.selectFrom("messages")
		.leftJoin("message_labels", "message_labels.message_id", "messages.id")
		.leftJoin(
			"classification_results",
			"classification_results.id",
			"message_labels.classification_result_id",
		)
		.leftJoin(
			"moderation_results",
			"moderation_results.message_id",
			"messages.id",
		)
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
		.where("messages.account_id", "=", job.scope_id);

	if (isTargeted) {
		messagesQuery = messagesQuery.where("messages.id", "in", targetMessageIds);
	} else {
		messagesQuery = messagesQuery.where((eb) =>
			eb.or([
				eb("moderation_results.message_id", "is", null),
				staleModerationPromptSql(),
				eb("message_labels.message_id", "is", null),
				eb("message_labels.schema_version", "!=", "message-label.v3"),
				sql<boolean>`coalesce(message_labels.content_sha256, '') != coalesce(messages.content_sha256, '')`,
				staleRootPromptSql(classifyPromptSha256),
			]),
		);
	}

	const messages = await messagesQuery
		.orderBy("messages.received_at", "desc")
		.orderBy("messages.id", "desc")
		.limit(isTargeted ? targetMessageIds.length : ROOT_BACKLOG_BATCH_SIZE)
		.execute();
	const skipped: Array<{ messageId: string; reason: string }> = [];
	if (isTargeted) {
		const foundIds = new Set(messages.map((message) => message.id));
		for (const messageId of targetMessageIds) {
			if (!foundIds.has(messageId)) {
				skipped.push({ messageId, reason: "not_found" });
			}
		}
	}

	backlogTrace.add({
		total: messages.length,
	});

	if (messages.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: buildProgressMeta(job, {
				total: 0,
				processed: 0,
				extra: isTargeted ? { targetMessageIds, skipped } : {},
			}),
		});
		backlogTrace.complete(`worker.${eventOperation}.complete`, {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	const overseerCtx = await loadLatestOverseerContext(account.id);
	const allowedTags = mergeAllowedTags(overseerCtx.promotedTags);
	const messageIds = messages.map((message) => message.id);
	const attachmentRows = await db
		.selectFrom("attachments")
		.select([
			"attachments.message_id",
			"attachments.filename",
			"attachments.mime_type",
		])
		.where("attachments.message_id", "in", messageIds)
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
		meta: buildProgressMeta(job, {
			processed: 0,
			total: messages.length,
			extra: isTargeted ? { targetMessageIds, skipped } : {},
		}),
	});
	backlogTrace.info(`worker.${eventOperation}.start`, {
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
				accountId: account.id,
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
				meta: buildProgressMeta(job, {
					processed: successCount + errorCount,
					total: messages.length,
					extra: isTargeted ? { targetMessageIds, skipped } : {},
				}),
			});
			const processed = successCount + errorCount;
			if (processed % 25 === 0 || processed === messages.length) {
				backlogTrace.info(`worker.${eventOperation}.progress`, {
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
		meta: buildProgressMeta(job, {
			processed: successCount + errorCount,
			total: messages.length,
			extra: isTargeted ? { targetMessageIds, skipped } : {},
		}),
	});
	backlogTrace.complete(`worker.${eventOperation}.complete`, {
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
		await queueReviewClassifierBacklog();
	}
	if (!isTargeted && (await hasPendingRootBacklog(account.id))) {
		await queueAccountBacklog(account.id);
	}
}

async function classifyFinanceBacklogJob(job: JobRecord, trace: LogTrace) {
	const isTargeted = job.kind === "classify_finance_messages";
	const operation = isTargeted
		? "classify_finance_messages"
		: "classify_finance_backlog";
	const targetMessageIds = isTargeted ? targetMessageIdsForJob(job) : [];
	const backlogTrace = trace.child({
		kind: "worker",
		operation,
		job_id: job.id,
		job_kind: job.kind,
		account_id: job.scope_id,
	});

	if (isTargeted && targetMessageIds.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: buildProgressMeta(job, {
				processed: 0,
				total: 0,
				extra: { targetMessageIds, skipped: [] },
			}),
		});
		backlogTrace.complete(`worker.${operation}.complete`, {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.select(["id", "label", "email_address"])
		.where("id", "=", job.scope_id)
		.executeTakeFirstOrThrow();

	let rowsQuery = db
		.selectFrom("messages")
		.leftJoin("message_labels", "message_labels.message_id", "messages.id")
		.leftJoin("message_secondary_heads", (join) =>
			join
				.onRef("message_secondary_heads.message_id", "=", "messages.id")
				.on("message_secondary_heads.classifier_key", "=", "finance_intel"),
		)
		.leftJoin(
			"message_secondary_results",
			"message_secondary_results.id",
			"message_secondary_heads.secondary_result_id",
		)
		.select([
			"messages.id",
			"messages.content_sha256",
			"messages.parse_status",
			"messages.received_at",
			"messages.sender_address",
			"messages.subject",
			"messages.body_text_normalized",
			"message_labels.label_json",
			"message_secondary_heads.status as head_status",
			"message_secondary_results.schema_version as result_schema_version",
		])
		.where("messages.account_id", "=", job.scope_id);

	if (isTargeted) {
		rowsQuery = rowsQuery.where("messages.id", "in", targetMessageIds);
	}

	const rows = await rowsQuery
		.orderBy("messages.received_at", "desc")
		.orderBy("messages.id", "desc")
		.execute();

	const skipped: Array<{ messageId: string; reason: string }> = [];
	if (isTargeted) {
		const foundIds = new Set(rows.map((row) => row.id));
		for (const messageId of targetMessageIds) {
			if (!foundIds.has(messageId)) {
				skipped.push({ messageId, reason: "not_found" });
			}
		}
	}
	const rootFinanceRows = rows.flatMap((row) => {
		const rootLabel = parseCurrentMessageLabel(
			safeJsonParse(row.label_json, null),
		);
		if (isTargeted && row.parse_status !== "parsed") {
			skipped.push({ messageId: row.id, reason: "parse_status_not_parsed" });
			return [];
		}
		if (!rootLabel) {
			if (isTargeted) {
				skipped.push({ messageId: row.id, reason: "missing_current_label" });
			}
			return [];
		}
		if (!rootLabel.finance?.relevant) {
			if (isTargeted) {
				skipped.push({ messageId: row.id, reason: "finance_not_relevant" });
			}
			return [];
		}
		if (!rootLabel.finance.requiresFinanceIntel) {
			if (isTargeted) {
				skipped.push({
					messageId: row.id,
					reason: "finance_intel_not_required",
				});
			}
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
			meta: buildProgressMeta(job, {
				processed: 0,
				total: 0,
				extra: isTargeted ? { targetMessageIds, skipped } : {},
			}),
		});
		backlogTrace.complete(`worker.${operation}.complete`, {
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
	const financePromptSha256 = promptSha256ForName("finance-intel-v3.md");
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
			.select([
				"message_secondary_results.schema_version as result_schema_version",
				"message_secondary_results.prompt_version as prompt_version",
				"message_secondary_results.prompt_sha256 as prompt_sha256",
			])
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

	const workItems = rootFinanceRows
		.filter((row) => {
			const head = headsByMessage.get(row.id);
			let shouldProcess = false;
			if (row.parse_status === "error") {
				shouldProcess =
					!head ||
					head.status !== "blocked_parse_error" ||
					head.content_sha256 !== row.content_sha256 ||
					head.registry_sha256 !== registry.sha256 ||
					head.prompt_version !== FINANCE_INTEL_PROMPT_VERSION ||
					head.prompt_sha256 !== financePromptSha256;
			} else {
				shouldProcess =
					head?.result_schema_version !== "finance-intel.v3" ||
					!isSecondaryHeadCurrent(head, {
						contentSha256: row.content_sha256,
						registrySha256: registry.sha256,
						promptVersion: FINANCE_INTEL_PROMPT_VERSION,
						promptSha256: financePromptSha256,
					});
			}
			if (isTargeted && !shouldProcess) {
				skipped.push({ messageId: row.id, reason: "finance_head_current" });
			}
			return shouldProcess;
		})
		.slice(0, FINANCE_BACKLOG_BATCH_SIZE);

	backlogTrace.add({
		total: workItems.length,
	});

	if (workItems.length === 0) {
		await completeJob({
			id: job.id,
			successCount: 0,
			errorCount: 0,
			meta: buildProgressMeta(job, {
				processed: 0,
				total: 0,
				extra: {
					registrySha256: registry.sha256,
					blockedModelOutputCount: 0,
					...(isTargeted ? { targetMessageIds, skipped } : {}),
				},
			}),
		});
		backlogTrace.complete(`worker.${operation}.complete`, {
			processed: 0,
			success_count: 0,
			error_count: 0,
			total: 0,
		});
		return;
	}

	let successCount = 0;
	let errorCount = 0;
	let blockedModelOutputCount = 0;

	await updateJob({
		id: job.id,
		requestCount: workItems.length,
		model: APP_CONFIG.classifierModel,
		promptVersion: FINANCE_INTEL_PROMPT_VERSION,
		meta: buildProgressMeta(job, {
			processed: 0,
			total: workItems.length,
			extra: {
				registrySha256: registry.sha256,
				blockedModelOutputCount,
				...(isTargeted ? { targetMessageIds, skipped } : {}),
			},
		}),
	});
	backlogTrace.info(`worker.${operation}.start`, {
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
					schemaVersion: "finance-intel.v3",
					model: "system",
					backend: "system",
					promptVersion: FINANCE_INTEL_PROMPT_VERSION,
					promptSha256: financePromptSha256,
					source: "system",
					rawResponse: {
						reason: "parse_error",
						parseStatus: row.parse_status,
					},
					usage: null,
					result: {
						schemaVersion: "finance-intel.v3",
						messageKind: "other_finance",
						actionability: "manual_review",
						book: {
							scope: row.rootLabel.finance.bookHint,
							businessUsePercent: null,
							taxTreatmentHint: null,
							evidence: row.rootLabel.finance.evidence,
						},
						ledgerReadiness: {
							status: "blocked",
							reasons: ["parse_error"],
							requiredFixes: ["message_parse_recovery"],
						},
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
						dedupe: {
							messageEvidenceKey: `email:${row.id}`,
							sourceDocumentRefs: [],
							externalTransactionIds: [],
							normalizedComposites: [],
						},
						fieldConfidence: {
							amount: null,
							date: null,
							counterparty: null,
							accountMapping: null,
							book: 0,
							category: null,
							dedupe: 0,
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

			const result = await classifyFinanceMessageNow({
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
			if (result.blockedModelOutput) {
				blockedModelOutputCount += 1;
			}
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
				meta: buildProgressMeta(job, {
					processed: successCount + errorCount,
					total: workItems.length,
					extra: {
						registrySha256: registry.sha256,
						blockedModelOutputCount,
						...(isTargeted ? { targetMessageIds, skipped } : {}),
					},
				}),
			});
		},
	);

	const finalMeta = buildProgressMeta(job, {
		processed: successCount + errorCount,
		total: workItems.length,
		extra: {
			registrySha256: registry.sha256,
			blockedModelOutputCount,
			...(isTargeted ? { targetMessageIds, skipped } : {}),
		},
	});

	if (errorCount > 0) {
		await updateJob({
			id: job.id,
			successCount,
			errorCount,
			meta: finalMeta,
		});
		throw new Error(
			`Finance backlog failed ${errorCount} of ${workItems.length} items`,
		);
	}

	await completeJob({
		id: job.id,
		successCount,
		errorCount,
		meta: finalMeta,
	});
	backlogTrace.complete(`worker.${operation}.complete`, {
		processed: successCount + errorCount,
		success_count: successCount,
		error_count: errorCount,
		total: workItems.length,
	});

	if (successCount > 0) {
		await queueFinanceKnowledgeRebuild();
		await queueFinanceRollupsRebuild();
		await queueReviewClassifierBacklog();
	}
	if (!isTargeted && (await hasPendingFinanceBacklog(account.id))) {
		await queueAccountFinanceBacklog(account.id);
	}
}

async function processJob(job: JobRecord, trace: LogTrace) {
	switch (job.kind) {
		case "rebuild_overseer":
			await rebuildOverseerJob(job, trace);
			return;
		case "generate_finance_mapping_candidates":
			await generateFinanceMappingCandidatesJob(job, trace);
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
		case "process_finance_upload":
			await processFinanceUploadJob(job, trace);
			return;
		case "export_finance_beancount":
			await exportFinanceBeancountJob(job, trace);
			return;
		case "generate_tax_personal_package":
		case "generate_tax_business_quarter_package":
			await generateTaxReportJob(job, trace);
			return;
		case "classify_review_backlog":
			await classifyReviewBacklogJob(job, trace);
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
		case "classify_root_messages":
			await classifyAccountBacklogJob(job, trace);
			return;
		case "classify_finance_backlog":
			await classifyFinanceBacklogJob(job, trace);
			return;
		case "classify_finance_messages":
			await classifyFinanceBacklogJob(job, trace);
			return;
		default:
			throw new Error(`Unsupported job kind: ${job.kind satisfies never}`);
	}
}

async function processClaimedJob(job: JobRecord) {
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
	const startedAt = Date.now();

	try {
		await processJob(job, trace);
		recordJobComplete({
			kind: job.kind,
			scopeType: job.scope_type,
			status: "completed",
			durationMs: Date.now() - startedAt,
		});
		trace.complete("worker.job_complete");
	} catch (error) {
		recordJobComplete({
			kind: job.kind,
			scopeType: job.scope_type,
			status: "failed",
			durationMs: Date.now() - startedAt,
		});
		trace.fail("worker.job_fail", error);
		await failJob(job.id, error);
	} finally {
		clearInterval(heartbeat);
	}

	return true;
}

export async function runWorkerIteration(input: { waitOnIdle: boolean }) {
	const job = claimNextJob();
	if (!job) {
		if (input.waitOnIdle) {
			await delay(APP_CONFIG.workerPollMs);
		}
		return false;
	}

	return processClaimedJob(job);
}

async function workerLoop(orgId: string) {
	return runWithOrgContext(orgId, async () => {
		const workerTrace = startTrace({
			kind: "worker",
			operation: "worker_loop",
			org_id: orgId,
		});
		workerTrace.info("worker.start");
		runMigrations();
		await ensureAccountOwnershipBackfill();

		try {
			const { restoreWatchers } = await import("#/lib/watchers");
			await restoreWatchers();
			workerTrace.complete("worker.restore_watchers");
		} catch (error) {
			workerTrace.fail("worker.restore_watchers_failed", error);
		}

		await queuePendingBackfills(workerTrace);
		await queueStartupReconciliation(workerTrace);

		const inFlight = new Set<Promise<boolean>>();
		while (true) {
			requeueExpiredJobs();
			let claimed = 0;
			while (inFlight.size < APP_CONFIG.workerMaxJobConcurrency) {
				const job = claimNextJob({ claimOwner: orgId });
				if (!job) {
					break;
				}
				let task: Promise<boolean>;
				task = processClaimedJob(job).finally(() => {
					inFlight.delete(task);
				});
				inFlight.add(task);
				claimed += 1;
			}

			if (inFlight.size === 0 && claimed === 0) {
				await delay(APP_CONFIG.workerPollMs);
				continue;
			}
			await Promise.race(inFlight);
		}
	});
}

function startOrgWorker(orgId: string) {
	const loops = orgWorkerLoops();
	const existing = loops.get(orgId);
	if (existing) {
		return existing;
	}

	const loopPromise = workerLoop(orgId)
		.catch((error) => {
			startTrace({
				kind: "worker",
				operation: "worker_loop_crash",
				org_id: orgId,
			}).fail("worker.loop_crashed", error);
		})
		.finally(() => {
			if (loops.get(orgId) === loopPromise) {
				loops.delete(orgId);
			}
			refreshLegacyWorkerLoop();
		});
	loops.set(orgId, loopPromise);
	refreshLegacyWorkerLoop();
	return loopPromise;
}

export function ensureWorkerStarted(orgId?: string) {
	if (!APP_CONFIG.runWorker) {
		return;
	}

	const orgIds = discoverWorkerOrgIds(orgId);
	if (!globalThis.__zmailWorkerStarted__) {
		globalThis.__zmailWorkerStarted__ = true;
		startTrace({
			kind: "worker",
			operation: "worker_supervisor",
		}).info("worker.supervisor.start", {
			org_ids: orgIds,
		});
	}

	orgIds.forEach((candidateOrgId) => {
		startOrgWorker(candidateOrgId);
	});
	refreshLegacyWorkerLoop();
}

async function drainOrgWorkerUntilIdle(orgId: string) {
	return runWithOrgContext(orgId, async () => {
		const trace = startTrace({
			kind: "worker",
			operation: "drain_worker",
			org_id: orgId,
		});
		trace.info("worker.drain.start");
		runMigrations();
		await ensureAccountOwnershipBackfill();
		requeueExpiredJobs();
		await queuePendingBackfills(trace);
		await queueStartupReconciliation(trace);

		while (await runWorkerIteration({ waitOnIdle: false })) {
			// Drain until no queued or expired jobs remain.
		}
		trace.complete("worker.drain.complete");
	});
}

export async function drainWorkerUntilIdle(input?: { orgId?: string }) {
	const orgIds = input?.orgId ? [input.orgId] : discoverWorkerOrgIds();
	for (const orgId of orgIds) {
		await drainOrgWorkerUntilIdle(orgId);
	}
}
