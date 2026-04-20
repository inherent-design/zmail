import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
	APP_CONFIG,
	CLASSIFY_PROMPT_VERSION,
	FINANCE_INTEL_PROMPT_VERSION,
	FINANCE_KNOWLEDGE_PROMPT_VERSION,
	OVERSEER_PROMPT_VERSION,
	REVIEW_CLASSIFIER_PROMPT_VERSION,
} from "#/lib/config";
import { isGoogleOAuthBootstrapErrorMessage } from "#/lib/google-oauth";
import { type LogFields, type LogTrace, startTrace } from "#/lib/log";
import type { AccountConnectionState } from "#/lib/schemas";

let bootServerOnce: Promise<typeof import("#/lib/db")> | null = null;

function normalizeOwnerPrincipalEmail(email: string) {
	return email.trim().toLowerCase();
}

function sourceStatePriority(state: string) {
	return state === "active" ? 0 : 1;
}

function buildPreferredSourceByMessageId<
	T extends {
		message_id: string;
		state: string;
		updated_at: string;
	},
>(rows: T[]) {
	const sortedRows = [...rows].sort((left, right) => {
		const stateOrder =
			sourceStatePriority(left.state) - sourceStatePriority(right.state);
		if (stateOrder !== 0) {
			return stateOrder;
		}
		return right.updated_at.localeCompare(left.updated_at);
	});
	const preferred = new Map<string, T>();
	for (const row of sortedRows) {
		if (!preferred.has(row.message_id)) {
			preferred.set(row.message_id, row);
		}
	}
	return preferred;
}

const MESSAGE_PAGE_SIZE_OPTIONS = [50, 100, 250] as const;

type MessagePageSize = (typeof MESSAGE_PAGE_SIZE_OPTIONS)[number];

export interface MessagesDataInput {
	q?: string | null;
	accountId?: string | null;
	bucket?: string | null;
	parseStatus?: string | null;
	page?: string | number | null;
	pageSize?: string | number | null;
}

function normalizeMessagePageNumber(value: string | number | null | undefined) {
	const parsed = Number(value ?? 1);
	if (!Number.isInteger(parsed) || parsed < 1) {
		return 1;
	}
	return parsed;
}

function normalizeMessagePageSize(value: string | number | null | undefined) {
	const parsed = Number(value ?? 100);
	if (MESSAGE_PAGE_SIZE_OPTIONS.includes(parsed as MessagePageSize)) {
		return parsed as MessagePageSize;
	}
	return 100;
}

function normalizeNullableFilter(value: string | null | undefined) {
	const normalized = value?.trim() ?? "";
	return normalized.length > 0 ? normalized : null;
}

function normalizeMessagesInput(input: MessagesDataInput = {}) {
	const parseStatus = normalizeNullableFilter(input.parseStatus);
	return {
		q: normalizeNullableFilter(input.q)?.slice(0, 200) ?? null,
		accountId: normalizeNullableFilter(input.accountId),
		bucket: normalizeNullableFilter(input.bucket),
		parseStatus:
			parseStatus === "parsed" || parseStatus === "error" ? parseStatus : null,
		page: normalizeMessagePageNumber(input.page),
		pageSize: normalizeMessagePageSize(input.pageSize),
	};
}

function createFinanceStatusCounts() {
	return {
		ready: 0,
		review: 0,
		stale: 0,
		blockedParseError: 0,
	};
}

function parseFinanceRelevant(
	safeJsonParse: <T>(input: string | null, fallback: T) => T,
	labelJson: string | null,
) {
	const label = safeJsonParse<{ finance?: { relevant?: boolean } } | null>(
		labelJson,
		null,
	);
	return Boolean(label?.finance?.relevant);
}

async function loadRegistryState(
	db: Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>,
	safeJsonParse: <T>(input: string | null, fallback: T) => T,
) {
	const state = await db
		.selectFrom("registry_import_state")
		.selectAll()
		.where("key", "=", "operator_registry")
		.executeTakeFirst();

	if (!state) {
		return {
			sha256: null,
			importedAt: null,
			sourceDir: APP_CONFIG.registryDir,
			counts: {
				identities: 0,
				institutions: 0,
				financialAccounts: 0,
				senderRules: 0,
			},
		};
	}

	return {
		sha256: state.combined_sha256,
		importedAt: state.imported_at,
		sourceDir: state.source_dir,
		counts: safeJsonParse(state.counts_json, {
			identities: 0,
			institutions: 0,
			financialAccounts: 0,
			senderRules: 0,
		}),
	};
}

async function loadFinanceCoverageSummary(input: {
	db: Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>;
	safeJsonParse: <T>(input: string | null, fallback: T) => T;
	accountId?: string;
}) {
	let labelQuery = input.db
		.selectFrom("message_labels")
		.innerJoin("messages", "messages.id", "message_labels.message_id")
		.select(["message_labels.label_json"]);
	let headQuery = input.db
		.selectFrom("message_secondary_heads")
		.leftJoin(
			"message_secondary_results",
			"message_secondary_results.id",
			"message_secondary_heads.secondary_result_id",
		)
		.innerJoin("messages", "messages.id", "message_secondary_heads.message_id")
		.select([
			"message_secondary_heads.status",
			"message_secondary_heads.message_id",
			"message_secondary_results.schema_version as result_schema_version",
		])
		.where("message_secondary_heads.classifier_key", "=", "finance_intel");
	const ledgerQuery = input.db
		.selectFrom("finance_ledger_entries")
		.select(["status"]);
	const patternQuery = input.db.selectFrom("finance_patterns").select(["id"]);

	if (input.accountId) {
		labelQuery = labelQuery.where("messages.account_id", "=", input.accountId);
		headQuery = headQuery.where("messages.account_id", "=", input.accountId);
	}

	const [labelRows, headRows, ledgerRows, patternRows] = await Promise.all([
		labelQuery.execute(),
		headQuery.execute(),
		ledgerQuery.execute(),
		patternQuery.execute(),
	]);

	const rootFinanceRelevantCount = labelRows.reduce((count, row) => {
		return (
			count + Number(parseFinanceRelevant(input.safeJsonParse, row.label_json))
		);
	}, 0);

	const statusCounts = createFinanceStatusCounts();
	let financeV2HeadCount = 0;
	let financeV3HeadCount = 0;
	for (const head of headRows) {
		switch (head.status) {
			case "ready":
				statusCounts.ready += 1;
				break;
			case "review":
				statusCounts.review += 1;
				break;
			case "stale":
				statusCounts.stale += 1;
				break;
			case "blocked_parse_error":
				statusCounts.blockedParseError += 1;
				break;
			default:
				break;
		}
		if (head.result_schema_version === "finance-intel.v2") {
			financeV2HeadCount += 1;
		}
		if (head.result_schema_version === "finance-intel.v3") {
			financeV3HeadCount += 1;
		}
	}

	const ledgerStatusCounts = ledgerRows.reduce(
		(counts, row) => {
			if (row.status === "ready") {
				counts.ready += 1;
			} else if (row.status === "review") {
				counts.review += 1;
			} else if (row.status === "blocked") {
				counts.blocked += 1;
			} else if (row.status === "duplicate") {
				counts.duplicate += 1;
			}
			return counts;
		},
		{ ready: 0, review: 0, blocked: 0, duplicate: 0 },
	);

	return {
		rootFinanceRelevantCount,
		totalHeads: headRows.length,
		financeV2HeadCount,
		financeV3HeadCount,
		readyCount: statusCounts.ready,
		reviewCount: statusCounts.review,
		staleCount: statusCounts.stale,
		blockedParseErrorCount: statusCounts.blockedParseError,
		ledgerEntryCount: ledgerRows.length,
		ledgerReadyCount: ledgerStatusCounts.ready,
		ledgerReviewCount: ledgerStatusCounts.review,
		ledgerBlockedCount: ledgerStatusCounts.blocked,
		ledgerDuplicateCount: ledgerStatusCounts.duplicate,
		patternCount: patternRows.length,
		eventCandidateCount: 0,
		documentCandidateCount: 0,
	};
}

async function loadOpenJobCounts(
	db: Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>,
	kinds: string[],
) {
	const rows = await db
		.selectFrom("jobs")
		.select(["kind", "status", (eb) => eb.fn.countAll<number>().as("count")])
		.where("kind", "in", kinds)
		.where("status", "in", ["queued", "running"])
		.groupBy(["kind", "status"])
		.execute();

	const counts = Object.fromEntries(
		kinds.map((kind) => [kind, { queued: 0, running: 0 }]),
	) as Record<string, { queued: number; running: number }>;

	for (const row of rows) {
		const current = counts[row.kind] ?? { queued: 0, running: 0 };
		if (row.status === "queued" || row.status === "running") {
			current[row.status] = Number(row.count);
		}
		counts[row.kind] = current;
	}

	return counts;
}

async function loadGoogleOAuthReadiness() {
	const [{ isOAuthConfigured, missingOAuthVars }, { GOOGLE_OAUTH }] =
		await Promise.all([import("#/lib/google-oauth"), import("#/lib/config")]);

	return {
		oauthReady: isOAuthConfigured(),
		missingVars: missingOAuthVars(),
		redirectUrl: GOOGLE_OAUTH.redirectUrl,
	};
}

export function deriveAccountConnectionState(
	account: {
		last_error: string | null;
		sync_enabled: number;
		sync_status: string;
	},
	hasOAuthToken: boolean,
): AccountConnectionState {
	if (isGoogleOAuthBootstrapErrorMessage(account.last_error)) {
		return "config_error";
	}
	if (account.sync_status === "needs_reconnect") {
		return "needs_reconnect";
	}
	if (!hasOAuthToken) {
		return "disconnected";
	}
	if (account.sync_status === "paused" || account.sync_enabled === 0) {
		return "paused";
	}
	return "connected";
}

async function loadAccountConnectionState(accountId: string) {
	const [{ getDb }, { readOAuthToken }] = await Promise.all([
		bootServer(),
		import("#/lib/google-oauth"),
	]);
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();
	const hasOAuthToken = Boolean(readOAuthToken(account.id));
	return {
		db,
		account,
		hasOAuthToken,
		connectionState: deriveAccountConnectionState(account, hasOAuthToken),
	};
}

/**
 * Recompute the canonical connection_state column from the current source
 * fields (last_error, sync_enabled, sync_status, token file). Call this at
 * every mutation site that touches one of those inputs so the cached column
 * cannot drift. Returns the derived state.
 */
export async function syncAccountConnectionState(accountId: string) {
	const { db, account, hasOAuthToken, connectionState } =
		await loadAccountConnectionState(accountId);
	if (account.connection_state !== connectionState) {
		const { nowIso } = await import("#/lib/config");
		await db
			.updateTable("accounts")
			.set({ connection_state: connectionState, updated_at: nowIso() })
			.where("id", "=", accountId)
			.execute();
	}
	return { connectionState, hasOAuthToken };
}

export async function loadAccountLifecycleAccessData(input: {
	accountId: string;
}) {
	const accountState = await loadAccountConnectionState(input.accountId);
	return {
		account: accountState.account,
		hasOAuthToken: accountState.hasOAuthToken,
		connectionState: accountState.connectionState,
	};
}

async function bootServer() {
	if (!bootServerOnce) {
		bootServerOnce = (async () => {
			const [
				{ ensureWorkerStarted },
				dbModule,
				{ ensureClassificationConfigFiles },
				{ ensureOperatorRegistryFiles },
			] = await Promise.all([
				import("#/lib/worker"),
				import("#/lib/db"),
				import("#/lib/category-rules"),
				import("#/lib/registry"),
			]);
			dbModule.runMigrations();
			await dbModule.ensureAccountOwnershipBackfill();
			ensureClassificationConfigFiles();
			ensureOperatorRegistryFiles();
			ensureWorkerStarted();
			return dbModule;
		})().catch((error) => {
			bootServerOnce = null;
			throw error;
		});
	}

	return bootServerOnce;
}

async function runLoggedAction<TResult>(input: {
	operation: string;
	kind: "loader" | "command";
	context?: LogFields;
	run: (trace: LogTrace) => Promise<TResult>;
	summarize?: (result: TResult) => LogFields;
}) {
	const trace = startTrace({
		kind: input.kind,
		operation: input.operation,
		...(input.context ?? {}),
	});
	trace.info("server.action.start");

	try {
		const result = await input.run(trace);
		trace.complete("server.action.complete", input.summarize?.(result));
		return result;
	} catch (error) {
		trace.fail("server.action.fail", error);
		throw error;
	}
}

async function assertRemoteSyncCommandAllowed(accountId: string) {
	const { getDb } = await bootServer();
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.select(["id", "sync_enabled", "sync_status"])
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();

	if (account.sync_enabled !== 1) {
		throw new Error(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);
	}

	return { db, account };
}

async function queueFinanceBacklogJob(accountId: string) {
	const { queueJobIdempotent } = await import("#/lib/jobs");
	return queueJobIdempotent({
		kind: "classify_finance_backlog",
		scopeType: "account",
		scopeId: accountId,
		model: APP_CONFIG.classifierModel,
		promptVersion: FINANCE_INTEL_PROMPT_VERSION,
	});
}

async function queueFinanceKnowledgeJob() {
	const { queueJobIdempotent } = await import("#/lib/jobs");
	return queueJobIdempotent({
		kind: "rebuild_finance_knowledge",
		scopeType: "system",
		scopeId: "finance",
		model: APP_CONFIG.fallbackModel,
		promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
	});
}

async function queueFinanceRollupsJob() {
	const { queueJobIdempotent } = await import("#/lib/jobs");
	return queueJobIdempotent({
		kind: "rebuild_finance_rollups",
		scopeType: "system",
		scopeId: "finance_rollups",
		model: APP_CONFIG.fallbackModel,
		promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
	});
}

async function queueRegistrySuggestionReconcileJob() {
	const { queueJobIdempotent } = await import("#/lib/jobs");
	return queueJobIdempotent({
		kind: "reconcile_registry_suggestions",
		scopeType: "system",
		scopeId: "registry_suggestions",
		model: APP_CONFIG.fallbackModel,
		promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
	});
}

export async function loadHomeData() {
	return runLoggedAction({
		operation: "loadHomeData",
		kind: "loader",
		run: async () => {
			const { getDb } = await bootServer();
			const db = getDb();
			const [messages, reviews, jobs, accounts, laneProgress] =
				await Promise.all([
					db
						.selectFrom("messages")
						.select((eb) => eb.fn.countAll<number>().as("count"))
						.executeTakeFirstOrThrow(),
					db
						.selectFrom("reviews")
						.select((eb) => eb.fn.countAll<number>().as("count"))
						.where("status", "=", "open")
						.executeTakeFirstOrThrow(),
					db
						.selectFrom("jobs")
						.select((eb) => eb.fn.countAll<number>().as("count"))
						.executeTakeFirstOrThrow(),
					db
						.selectFrom("accounts")
						.select((eb) => eb.fn.countAll<number>().as("count"))
						.executeTakeFirstOrThrow(),
					import("#/lib/job-lane-progress").then((module) =>
						module.loadGlobalLaneProgress(),
					),
				]);

			return {
				messages: Number(messages.count),
				openReviews: Number(reviews.count),
				jobs: Number(jobs.count),
				accounts: Number(accounts.count),
				laneProgress,
			};
		},
		summarize: (result) => ({
			messages: result.messages,
			open_reviews: result.openReviews,
			jobs: result.jobs,
			accounts: result.accounts,
			lanes: result.laneProgress.length,
		}),
	});
}

export async function loadMessagesData(input: MessagesDataInput = {}) {
	const filters = normalizeMessagesInput(input);
	return runLoggedAction({
		operation: "loadMessagesData",
		kind: "loader",
		context: {
			q: filters.q,
			account_id: filters.accountId,
			bucket: filters.bucket,
			parse_status: filters.parseStatus,
			page: filters.page,
			page_size: filters.pageSize,
		},
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			let rowsQuery = db
				.selectFrom("messages")
				.leftJoin("message_labels", "message_labels.message_id", "messages.id")
				.innerJoin("accounts", "accounts.id", "messages.account_id")
				.select([
					"messages.id",
					"messages.received_at",
					"messages.conversation_id",
					"messages.body_extraction_strategy",
					"messages.body_text_forwarded",
					"messages.parse_status",
					"messages.sender_address",
					"messages.subject",
					"accounts.label as account_label",
					"message_labels.primary_bucket",
					"message_labels.low_confidence",
					"message_labels.nsfw",
					"message_labels.label_json",
				]);
			let countQuery = db
				.selectFrom("messages")
				.leftJoin("message_labels", "message_labels.message_id", "messages.id")
				.innerJoin("accounts", "accounts.id", "messages.account_id");

			if (filters.q) {
				const pattern = `%${filters.q}%`;
				rowsQuery = rowsQuery.where((eb) =>
					eb.or([
						eb("messages.subject", "like", pattern),
						eb("messages.sender_address", "like", pattern),
						eb("messages.body_text_normalized", "like", pattern),
					]),
				);
				countQuery = countQuery.where((eb) =>
					eb.or([
						eb("messages.subject", "like", pattern),
						eb("messages.sender_address", "like", pattern),
						eb("messages.body_text_normalized", "like", pattern),
					]),
				);
			}
			if (filters.accountId) {
				rowsQuery = rowsQuery.where(
					"messages.account_id",
					"=",
					filters.accountId,
				);
				countQuery = countQuery.where(
					"messages.account_id",
					"=",
					filters.accountId,
				);
			}
			if (filters.bucket === "unlabeled") {
				rowsQuery = rowsQuery.where(
					"message_labels.primary_bucket",
					"is",
					null,
				);
				countQuery = countQuery.where(
					"message_labels.primary_bucket",
					"is",
					null,
				);
			} else if (filters.bucket) {
				rowsQuery = rowsQuery.where(
					"message_labels.primary_bucket",
					"=",
					filters.bucket,
				);
				countQuery = countQuery.where(
					"message_labels.primary_bucket",
					"=",
					filters.bucket,
				);
			}
			if (filters.parseStatus) {
				rowsQuery = rowsQuery.where(
					"messages.parse_status",
					"=",
					filters.parseStatus,
				);
				countQuery = countQuery.where(
					"messages.parse_status",
					"=",
					filters.parseStatus,
				);
			}

			const totalRow = await countQuery
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.executeTakeFirstOrThrow();
			const total = Number(totalRow.count);
			const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
			const page = Math.min(filters.page, totalPages);
			const offset = (page - 1) * filters.pageSize;
			const rows = await rowsQuery
				.orderBy("messages.received_at", "desc")
				.orderBy("messages.id", "desc")
				.limit(filters.pageSize)
				.offset(offset)
				.execute();
			const sourceRows =
				rows.length === 0
					? []
					: await db
							.selectFrom("message_sources")
							.select(["message_id", "remote_thread_id", "state", "updated_at"])
							.where(
								"message_id",
								"in",
								rows.map((row) => row.id),
							)
							.execute();
			const sourceByMessageId = buildPreferredSourceByMessageId(sourceRows);
			const [accounts, bucketRows] = await Promise.all([
				db
					.selectFrom("accounts")
					.select(["id", "label", "email_address"])
					.orderBy("label", "asc")
					.execute(),
				db
					.selectFrom("message_labels")
					.select(["primary_bucket"])
					.where("primary_bucket", "is not", null)
					.groupBy("primary_bucket")
					.orderBy("primary_bucket", "asc")
					.execute(),
			]);

			return {
				rows: rows.map(({ body_text_forwarded, ...row }) => ({
					...row,
					remote_thread_id:
						sourceByMessageId.get(row.id)?.remote_thread_id ?? null,
					has_forwarded: body_text_forwarded.length > 0,
					label: safeJsonParse(row.label_json ?? null, null),
				})),
				filters: {
					q: filters.q,
					accountId: filters.accountId,
					bucket: filters.bucket,
					parseStatus: filters.parseStatus,
					pageSize: filters.pageSize,
				},
				options: {
					accounts,
					buckets: bucketRows
						.map((row) => row.primary_bucket)
						.filter((value): value is string => Boolean(value)),
					pageSizes: [...MESSAGE_PAGE_SIZE_OPTIONS],
				},
				pagination: {
					page,
					pageSize: filters.pageSize,
					total,
					totalPages,
					hasPreviousPage: page > 1,
					hasNextPage: page < totalPages,
				},
			};
		},
		summarize: (result) => ({
			count: result.rows.length,
			total: result.pagination.total,
			page: result.pagination.page,
		}),
	});
}

export async function loadMessageDetailData(input: { messageId: string }) {
	return runLoggedAction({
		operation: "loadMessageDetailData",
		kind: "loader",
		context: {
			message_id: input.messageId,
		},
		run: async (trace) => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const message = await db
				.selectFrom("messages")
				.innerJoin("accounts", "accounts.id", "messages.account_id")
				.select([
					"messages.id",
					"messages.account_id",
					"accounts.label as account_label",
					"messages.message_id",
					"messages.thread_key",
					"messages.received_at",
					"messages.ingested_at",
					"messages.conversation_id",
					"messages.sender_name",
					"messages.sender_address",
					"messages.to_json",
					"messages.cc_json",
					"messages.subject",
					"messages.in_reply_to",
					"messages.body_text_primary",
					"messages.body_text_forwarded",
					"messages.body_text_normalized",
					"messages.snippet",
					"messages.attachment_count",
					"messages.has_html",
					"messages.parse_status",
					"messages.body_extraction_strategy",
					"messages.parse_error_reason",
					"messages.token_estimate",
					"messages.content_sha256",
				])
				.where("messages.id", "=", input.messageId)
				.executeTakeFirstOrThrow();
			trace.add({
				account_id: message.account_id,
			});

			const attachments = await db
				.selectFrom("attachments")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.execute();
			const sourceRows = await db
				.selectFrom("message_sources")
				.select([
					"message_id",
					"remote_thread_id",
					"raw_rfc822_path",
					"raw_sha256",
					"state",
					"updated_at",
				])
				.where("message_id", "=", input.messageId)
				.execute();
			const currentSource =
				buildPreferredSourceByMessageId(sourceRows).get(input.messageId) ??
				null;

			const moderation = await db
				.selectFrom("moderation_results")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.executeTakeFirst();

			const classifications = await db
				.selectFrom("classification_results")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.orderBy("created_at", "desc")
				.execute();

			const currentLabel = await db
				.selectFrom("message_labels")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.executeTakeFirst();

			const latestProfile = await db
				.selectFrom("overseer_profiles")
				.select(["profile_json"])
				.where("account_id", "=", message.account_id)
				.orderBy("created_at", "desc")
				.executeTakeFirst();
			const financeHead = await db
				.selectFrom("message_secondary_heads")
				.leftJoin(
					"message_secondary_results",
					"message_secondary_results.id",
					"message_secondary_heads.secondary_result_id",
				)
				.select([
					"message_secondary_heads.status",
					"message_secondary_heads.low_confidence",
					"message_secondary_heads.content_sha256",
					"message_secondary_heads.registry_sha256",
					"message_secondary_heads.updated_at",
					"message_secondary_results.id as result_id",
					"message_secondary_results.schema_version",
					"message_secondary_results.model",
					"message_secondary_results.prompt_version",
					"message_secondary_results.source",
					"message_secondary_results.result_json",
					"message_secondary_results.raw_response_json",
					"message_secondary_results.usage_json",
					"message_secondary_results.created_at",
				])
				.where("message_secondary_heads.message_id", "=", input.messageId)
				.where("message_secondary_heads.classifier_key", "=", "finance_intel")
				.executeTakeFirst();
			const financeHistory = await db
				.selectFrom("message_secondary_results")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.where("classifier_key", "=", "finance_intel")
				.orderBy("created_at", "desc")
				.execute();
			const financeEvidence = await db
				.selectFrom("finance_event_evidence")
				.leftJoin(
					"finance_event_candidates",
					"finance_event_candidates.id",
					"finance_event_evidence.event_candidate_id",
				)
				.leftJoin(
					"finance_document_candidates",
					"finance_document_candidates.id",
					"finance_event_evidence.document_candidate_id",
				)
				.select([
					"finance_event_evidence.id",
					"finance_event_evidence.event_candidate_id",
					"finance_event_evidence.document_candidate_id",
					"finance_event_evidence.transaction_index",
					"finance_event_evidence.document_index",
					"finance_event_evidence.evidence_json",
					"finance_event_candidates.canonical_key as event_canonical_key",
					"finance_event_candidates.status as event_status",
					"finance_document_candidates.canonical_key as document_canonical_key",
					"finance_document_candidates.status as document_status",
				])
				.where("finance_event_evidence.message_id", "=", input.messageId)
				.orderBy("finance_event_evidence.created_at", "desc")
				.execute();

			return {
				message: {
					...message,
					remote_thread_id: currentSource?.remote_thread_id ?? null,
					raw_rfc822_path: currentSource?.raw_rfc822_path ?? null,
					raw_sha256: currentSource?.raw_sha256 ?? null,
					to: safeJsonParse(message.to_json, []),
					cc: safeJsonParse(message.cc_json, []),
				},
				attachments,
				moderation: moderation
					? {
							...moderation,
							categories: safeJsonParse(moderation.categories_json, {}),
							categoryScores: safeJsonParse(
								moderation.category_scores_json,
								{},
							),
						}
					: null,
				classifications: classifications.map((row) => ({
					...row,
					result: safeJsonParse(row.result_json, null),
					usage: safeJsonParse(row.usage_json, null),
				})),
				currentLabel: currentLabel
					? {
							...currentLabel,
							label: safeJsonParse(currentLabel.label_json, null),
						}
					: null,
				latestProfile: latestProfile
					? safeJsonParse(latestProfile.profile_json, null)
					: null,
				financeIntel: financeHead
					? {
							head: {
								status: financeHead.status,
								lowConfidence: financeHead.low_confidence,
								contentSha256: financeHead.content_sha256,
								registrySha256: financeHead.registry_sha256,
								updatedAt: financeHead.updated_at,
							},
							current: financeHead.result_id
								? {
										id: financeHead.result_id,
										schemaVersion: financeHead.schema_version,
										model: financeHead.model,
										promptVersion: financeHead.prompt_version,
										source: financeHead.source,
										createdAt: financeHead.created_at,
										result: safeJsonParse(financeHead.result_json, null),
										rawResponse: safeJsonParse(
											financeHead.raw_response_json,
											null,
										),
										usage: safeJsonParse(financeHead.usage_json ?? null, null),
									}
								: null,
							history: financeHistory.map((row) => ({
								id: row.id,
								schemaVersion: row.schema_version,
								model: row.model,
								promptVersion: row.prompt_version,
								source: row.source,
								createdAt: row.created_at,
								result: safeJsonParse(row.result_json, null),
								rawResponse: safeJsonParse(row.raw_response_json, null),
								usage: safeJsonParse(row.usage_json ?? null, null),
							})),
							evidence: financeEvidence.map((row) => ({
								id: row.id,
								eventCandidateId: row.event_candidate_id,
								documentCandidateId: row.document_candidate_id,
								transactionIndex: row.transaction_index,
								documentIndex: row.document_index,
								eventCanonicalKey: row.event_canonical_key,
								eventStatus: row.event_status,
								documentCanonicalKey: row.document_canonical_key,
								documentStatus: row.document_status,
								evidenceJson: row.evidence_json,
							})),
						}
					: null,
			};
		},
		summarize: (result) => ({
			account_id: result.message.account_id,
			attachments: result.attachments.length,
			classifications: result.classifications.length,
			has_moderation: Boolean(result.moderation),
			has_current_label: Boolean(result.currentLabel),
			has_latest_profile: Boolean(result.latestProfile),
			has_finance_intel: Boolean(result.financeIntel),
		}),
	});
}

export async function loadReviewData() {
	return runLoggedAction({
		operation: "loadReviewData",
		kind: "loader",
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const rows = await db
				.selectFrom("reviews")
				.innerJoin("messages", "messages.id", "reviews.message_id")
				.innerJoin(
					"classification_results",
					"classification_results.id",
					"reviews.source_classification_result_id",
				)
				.select([
					"reviews.id",
					"reviews.status",
					"reviews.created_at",
					"messages.id as message_id",
					"messages.sender_address",
					"messages.subject",
					"messages.snippet",
					"messages.body_extraction_strategy",
					"messages.body_text_forwarded",
					"messages.parse_status",
					"messages.parse_error_reason",
					"classification_results.result_json",
				])
				.where("reviews.status", "=", "open")
				.orderBy("reviews.created_at", "asc")
				.execute();

			const [findingRows, resultRows] = await Promise.all([
				db
					.selectFrom("review_classification_heads")
					.selectAll()
					.orderBy("updated_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("review_classification_results")
					.select([
						"id",
						"schema_version",
						"model",
						"prompt_version",
						"created_at",
						"result_json",
					])
					.orderBy("created_at", "desc")
					.limit(20)
					.execute(),
			]);

			return {
				rootReviews: rows.map(({ body_text_forwarded, ...row }) => ({
					...row,
					has_forwarded: body_text_forwarded.length > 0,
					result: safeJsonParse(row.result_json, null),
				})),
				findings: findingRows.map((row) => ({
					...row,
					evidenceRefs: safeJsonParse(row.evidence_refs_json, []),
				})),
				actionHistory: resultRows.map((row) => ({
					id: row.id,
					schemaVersion: row.schema_version,
					model: row.model,
					promptVersion: row.prompt_version,
					createdAt: row.created_at,
					result: safeJsonParse(row.result_json, null),
				})),
			};
		},
		summarize: (result) => ({
			count: result.rootReviews.length,
			findings: result.findings.length,
		}),
	});
}

export async function loadRunsData() {
	return runLoggedAction({
		operation: "loadRunsData",
		kind: "loader",
		run: async () => {
			const [{ listJobs }, { getPiStatus }, { loadGlobalLaneProgress }] =
				await Promise.all([
					import("#/lib/jobs"),
					import("#/lib/pi"),
					import("#/lib/job-lane-progress"),
				]);
			await bootServer();
			const [jobs, runtime, laneProgress] = await Promise.all([
				listJobs(),
				getPiStatus(),
				loadGlobalLaneProgress(),
			]);
			return {
				jobs: jobs.map((job) => ({
					...job,
					progress: parseJobProgressFields(job.meta_json),
				})),
				runtime,
				laneProgress,
			};
		},
		summarize: (result) => ({
			jobs: result.jobs.length,
			lanes: result.laneProgress.length,
			resolved_backend: result.runtime.resolvedBackend ?? "unavailable",
		}),
	});
}

function parseJobProgressFields(metaJson: string | null) {
	if (!metaJson) {
		return {
			processed: null,
			total: null,
			etaSeconds: null,
			updatedAt: null,
			phase: null,
		};
	}
	try {
		const parsed = JSON.parse(metaJson) as Record<string, unknown>;
		return {
			processed: typeof parsed.processed === "number" ? parsed.processed : null,
			total: typeof parsed.total === "number" ? parsed.total : null,
			etaSeconds:
				typeof parsed.etaSeconds === "number" ? parsed.etaSeconds : null,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
			phase: typeof parsed.phase === "string" ? parsed.phase : null,
		};
	} catch {
		return {
			processed: null,
			total: null,
			etaSeconds: null,
			updatedAt: null,
			phase: null,
		};
	}
}

export async function loadProfileData(input: { accountId: string }) {
	return runLoggedAction({
		operation: "loadProfileData",
		kind: "loader",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const [account, profiles, financeCoverage] = await Promise.all([
				db
					.selectFrom("accounts")
					.selectAll()
					.where("id", "=", input.accountId)
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("overseer_profiles")
					.selectAll()
					.where("account_id", "=", input.accountId)
					.orderBy("created_at", "desc")
					.execute(),
				loadFinanceCoverageSummary({
					db,
					safeJsonParse,
					accountId: input.accountId,
				}),
			]);
			return {
				account,
				financeCoverage,
				profiles: profiles.map((profile) => ({
					...profile,
					profile: safeJsonParse(profile.profile_json, null),
					promotedTags: safeJsonParse(profile.promoted_tags_json, []),
				})),
			};
		},
		summarize: (result) => ({
			profiles: result.profiles.length,
			root_finance_relevant: result.financeCoverage.rootFinanceRelevantCount,
			finance_heads: result.financeCoverage.totalHeads,
		}),
	});
}

export async function loadFinanceData(
	input: {
		year?: number;
		accountId?: string;
		institutionId?: string;
		ownerIdentityId?: string;
		sourceKind?: "email" | "pdf" | "statement" | "csv" | "ofx";
	} = {},
) {
	return runLoggedAction({
		operation: "loadFinanceData",
		kind: "loader",
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const { buildFinanceRollupView, loadCombinedFinanceLedger } =
				await import("#/lib/finance-rollups");
			const { rebuildFinanceRollups } = await import("#/lib/finance-rollups");
			const db = getDb();
			const [
				registry,
				coverage,
				jobCounts,
				ledger,
				rollupRows,
				subcategoryRows,
				importDocumentRows,
				importTransactionRows,
				suggestionRows,
				accountRows,
				exportRuns,
				exportItems,
				patternRows,
				mappingRows,
				reviewFindingRows,
				taxReportRows,
				laneProgress,
			] = await Promise.all([
				loadRegistryState(db, safeJsonParse),
				loadFinanceCoverageSummary({ db, safeJsonParse }),
				loadOpenJobCounts(db, [
					"classify_finance_backlog",
					"classify_finance_messages",
					"classify_review_backlog",
					"rebuild_finance_knowledge",
					"rebuild_finance_rollups",
					"export_finance_beancount",
					"generate_tax_personal_package",
					"generate_tax_business_quarter_package",
				]),
				loadCombinedFinanceLedger(),
				db
					.selectFrom("finance_yearly_rollups")
					.selectAll()
					.orderBy("year", "desc")
					.orderBy("primary_category", "asc")
					.execute(),
				db
					.selectFrom("finance_yearly_subcategory_rollups")
					.selectAll()
					.orderBy("year", "desc")
					.orderBy("primary_category", "asc")
					.orderBy("secondary_category", "asc")
					.execute(),
				db
					.selectFrom("finance_import_documents")
					.innerJoin(
						"finance_import_runs",
						"finance_import_runs.id",
						"finance_import_documents.import_run_id",
					)
					.select([
						"finance_import_documents.id",
						"finance_import_documents.document_type",
						"finance_import_documents.issuer",
						"finance_import_documents.external_id",
						"finance_import_documents.statement_period_start",
						"finance_import_documents.statement_period_end",
						"finance_import_documents.due_at",
						"finance_import_documents.tax_year",
						"finance_import_documents.owner_identity_hint",
						"finance_import_documents.financial_account_hint",
						"finance_import_documents.institution_hint",
						"finance_import_documents.evidence_text",
						"finance_import_documents.created_at",
						"finance_import_runs.source_kind as source_kind",
					])
					.orderBy("created_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("finance_import_transactions")
					.innerJoin(
						"finance_import_runs",
						"finance_import_runs.id",
						"finance_import_transactions.import_run_id",
					)
					.select([
						"finance_import_transactions.id",
						"finance_import_transactions.import_run_id",
						"finance_import_transactions.source_document_ref",
						"finance_import_transactions.occurred_at",
						"finance_import_transactions.posted_at",
						"finance_import_transactions.cleared_at",
						"finance_import_transactions.amount_value",
						"finance_import_transactions.currency",
						"finance_import_transactions.direction",
						"finance_import_transactions.description",
						"finance_import_transactions.merchant_or_counterparty",
						"finance_import_transactions.external_transaction_id",
						"finance_import_transactions.statement_row_id",
						"finance_import_transactions.row_index",
						"finance_import_transactions.account_mapping_key",
						"finance_import_transactions.book_hint",
						"finance_import_transactions.extraction_confidence",
						"finance_import_transactions.created_at",
						"finance_import_runs.source_kind as source_kind",
					])
					.orderBy("finance_import_transactions.created_at", "desc")
					.limit(150)
					.execute(),
				db
					.selectFrom("registry_suggestions")
					.selectAll()
					.orderBy("updated_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("accounts")
					.select(["id", "label"])
					.orderBy("label", "asc")
					.execute(),
				db
					.selectFrom("finance_export_runs")
					.selectAll()
					.orderBy("created_at", "desc")
					.limit(50)
					.execute(),
				db
					.selectFrom("finance_export_items")
					.selectAll()
					.orderBy("created_at", "desc")
					.limit(500)
					.execute(),
				db
					.selectFrom("finance_patterns")
					.selectAll()
					.orderBy("last_seen_at", "desc")
					.orderBy("updated_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("finance_account_mappings")
					.selectAll()
					.orderBy("mapping_key", "asc")
					.execute(),
				db
					.selectFrom("review_classification_heads")
					.selectAll()
					.orderBy("updated_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("tax_report_runs")
					.selectAll()
					.orderBy("created_at", "desc")
					.limit(50)
					.execute(),
				import("#/lib/job-lane-progress").then((module) =>
					module.loadFinanceLaneProgress(),
				),
			]);

			if (rollupRows.length === 0 && ledger.length > 0) {
				await rebuildFinanceRollups();
			}
			const refreshedRollupRows =
				rollupRows.length > 0
					? rollupRows
					: await db
							.selectFrom("finance_yearly_rollups")
							.selectAll()
							.orderBy("year", "desc")
							.orderBy("primary_category", "asc")
							.execute();
			const refreshedSubcategoryRows =
				subcategoryRows.length > 0
					? subcategoryRows
					: await db
							.selectFrom("finance_yearly_subcategory_rollups")
							.selectAll()
							.orderBy("year", "desc")
							.orderBy("primary_category", "asc")
							.orderBy("secondary_category", "asc")
							.execute();

			const availableYears = Array.from(
				new Set([
					...ledger.map((entry) => entry.year),
					...refreshedRollupRows.map((row) => row.year),
					...exportRuns
						.map((row) => row.year)
						.filter((value): value is number => value !== null),
					...importDocumentRows
						.map((row) =>
							row.statement_period_end
								? Number.parseInt(row.statement_period_end.slice(0, 4), 10)
								: null,
						)
						.filter((value): value is number => Number.isInteger(value)),
				]),
			).sort((left, right) => right - left);
			const selectedYear =
				input.year ?? availableYears[0] ?? new Date().getUTCFullYear();
			const yearString = String(selectedYear);

			const matchesSelectedYear = (value: {
				statement_period_end: string | null;
				tax_year?: number | null;
			}) => {
				if (value.statement_period_end) {
					return value.statement_period_end.startsWith(yearString);
				}
				if (value.tax_year !== null && value.tax_year !== undefined) {
					return value.tax_year === selectedYear;
				}
				return true;
			};

			const matchesTransactionYear = (value: {
				occurred_at: string | null;
				posted_at: string | null;
				cleared_at: string | null;
			}) => {
				const date = value.occurred_at ?? value.posted_at ?? value.cleared_at;
				return date ? date.startsWith(yearString) : true;
			};

			const filteredLedger = ledger.filter((entry) => {
				if (entry.year !== selectedYear) {
					return false;
				}
				if (input.accountId && entry.accountId !== input.accountId) {
					return false;
				}
				if (input.sourceKind && entry.sourceKind !== input.sourceKind) {
					return false;
				}
				if (
					input.institutionId &&
					entry.institutionId !== input.institutionId
				) {
					return false;
				}
				if (
					input.ownerIdentityId &&
					entry.ownerIdentityId !== input.ownerIdentityId
				) {
					return false;
				}
				return true;
			});

			const filteredImportDocuments = importDocumentRows.filter((row) => {
				if (!matchesSelectedYear(row)) {
					return false;
				}
				if (input.accountId) {
					return false;
				}
				if (input.sourceKind && row.source_kind !== input.sourceKind) {
					return false;
				}
				if (
					input.institutionId &&
					row.institution_hint !== input.institutionId
				) {
					return false;
				}
				if (
					input.ownerIdentityId &&
					row.owner_identity_hint !== input.ownerIdentityId
				) {
					return false;
				}
				return true;
			});
			const filteredImportTransactions = importTransactionRows.filter((row) => {
				if (!matchesTransactionYear(row)) {
					return false;
				}
				if (input.accountId) {
					return false;
				}
				if (input.sourceKind && row.source_kind !== input.sourceKind) {
					return false;
				}
				return true;
			});
			const filteredSuggestionRows = suggestionRows.filter((row) =>
				input.sourceKind ? row.source_kind === input.sourceKind : true,
			);
			const hasGranularFilters = Boolean(
				input.accountId ||
					input.institutionId ||
					input.ownerIdentityId ||
					input.sourceKind,
			);
			const derivedRollups = buildFinanceRollupView({
				ledger: filteredLedger,
				importDocuments: filteredImportDocuments.map((row) => ({
					sourceKind: row.source_kind,
					statementPeriodEnd: row.statement_period_end,
				})),
			});
			const summary = derivedRollups.summary;
			const yearLedger = ledger.filter((entry) => entry.year === selectedYear);
			const readinessRows = yearLedger.filter(
				(entry) => entry.status !== "duplicate",
			);
			const readiness = {
				year: selectedYear,
				statusCounts: {
					ready: readinessRows.filter((row) => row.status === "ready").length,
					review: readinessRows.filter((row) => row.status === "review").length,
					blocked: readinessRows.filter((row) => row.status === "blocked")
						.length,
					duplicate: yearLedger.filter((row) => row.status === "duplicate")
						.length,
				},
				openJobsThatMayChangeTotals: Object.entries(jobCounts).flatMap(
					([kind, counts]) =>
						counts.queued + counts.running > 0
							? [{ kind, queued: counts.queued, running: counts.running }]
							: [],
				),
				mappingCoverage: {
					mappingCount: mappingRows.length,
					mappedRows: readinessRows.filter((row) => row.accountMappingKey)
						.length,
					totalRows: readinessRows.length,
				},
				missing: {
					amount: readinessRows.filter((row) => row.amountMinor === null)
						.length,
					date: readinessRows.filter((row) => !row.occurredAt).length,
					counterparty: readinessRows.filter((row) => !row.counterparty).length,
					mapping: readinessRows.filter((row) => !row.accountMappingKey).length,
					book: readinessRows.filter(
						(row) => row.book === "unknown" || !row.book,
					).length,
					dedupe: readinessRows.filter((row) => !row.canonicalKey).length,
				},
				freshness: {
					registryImportedAt: registry.importedAt,
					latestReviewFindingAt: reviewFindingRows[0]?.updated_at ?? null,
				},
			};
			const yearDocuments = importDocumentRows.filter(matchesSelectedYear);
			const institutionIds = Array.from(
				new Set(
					[
						...yearLedger.map((entry) => entry.institutionId),
						...yearDocuments.map((row) => row.institution_hint),
					].filter((value): value is string => Boolean(value)),
				),
			).sort((left, right) => left.localeCompare(right));
			const ownerIdentityIds = Array.from(
				new Set(
					[
						...yearLedger.map((entry) => entry.ownerIdentityId),
						...yearDocuments.map((row) => row.owner_identity_hint),
					].filter((value): value is string => Boolean(value)),
				),
			).sort((left, right) => left.localeCompare(right));
			const sourceKinds = Array.from(
				new Set(
					[
						...yearLedger.map((entry) => entry.sourceKind),
						...yearDocuments.map((row) => row.source_kind),
						...importTransactionRows.map((row) => row.source_kind),
						...suggestionRows.map((row) => row.source_kind),
						input.sourceKind ?? null,
					].filter((value): value is string => Boolean(value)),
				),
			).sort((left, right) => left.localeCompare(right));

			const exportItemCounts = new Map<string, number>();
			for (const row of exportItems) {
				exportItemCounts.set(
					row.export_run_id,
					(exportItemCounts.get(row.export_run_id) ?? 0) + 1,
				);
			}
			const cashflowSeries = Array.from({ length: 12 }, (_, index) => {
				const month = `${yearString}-${String(index + 1).padStart(2, "0")}`;
				return {
					month,
					inflowMinor: 0,
					outflowMinor: 0,
					netMinor: 0,
					transactionCount: 0,
				};
			});
			const categoryBreakdownMap = new Map<
				string,
				{
					primaryCategory: string;
					secondaryCategory: string | null;
					inflowMinor: number;
					outflowMinor: number;
					netMinor: number;
					transactionCount: number;
				}
			>();
			for (const entry of filteredLedger) {
				if (entry.status === "duplicate") {
					continue;
				}
				const amount = Math.abs(entry.amountMinor ?? 0);
				const monthIndex = entry.occurredAt
					? Number.parseInt(entry.occurredAt.slice(5, 7), 10) - 1
					: -1;
				if (monthIndex >= 0 && monthIndex < cashflowSeries.length) {
					const point = cashflowSeries[monthIndex];
					point.transactionCount += 1;
					if (entry.direction === "income") {
						point.inflowMinor += amount;
						point.netMinor += amount;
					} else if (entry.direction === "expense") {
						point.outflowMinor += amount;
						point.netMinor -= amount;
					}
				}
				const categoryKey = `${entry.primaryCategory}:${entry.secondaryCategory ?? ""}`;
				const category = categoryBreakdownMap.get(categoryKey) ?? {
					primaryCategory: entry.primaryCategory,
					secondaryCategory: entry.secondaryCategory,
					inflowMinor: 0,
					outflowMinor: 0,
					netMinor: 0,
					transactionCount: 0,
				};
				category.transactionCount += 1;
				if (entry.direction === "income") {
					category.inflowMinor += amount;
					category.netMinor += amount;
				} else if (entry.direction === "expense") {
					category.outflowMinor += amount;
					category.netMinor -= amount;
				}
				categoryBreakdownMap.set(categoryKey, category);
			}
			const categoryBreakdown = [...categoryBreakdownMap.values()].sort(
				(left, right) =>
					right.outflowMinor - left.outflowMinor ||
					right.inflowMinor - left.inflowMinor ||
					left.primaryCategory.localeCompare(right.primaryCategory),
			);
			const subscriptionPatterns = patternRows
				.filter((row) => row.pattern_kind === "recurring_merchant")
				.map((row) => {
					const summary = safeJsonParse<{
						counterparty?: string | null;
						book?: string | null;
						transactionCount?: number | null;
						canonicalKeys?: string[] | null;
						cadence?: string | null;
						amountBand?: string | null;
						nextExpectedAt?: string | null;
						lastAmountMinor?: number | null;
					}>(row.summary_json, {});
					return {
						id: row.id,
						patternKey: row.pattern_key,
						status: row.status,
						confidence: row.confidence,
						counterparty: summary.counterparty ?? row.pattern_key,
						book: summary.book ?? null,
						transactionCount:
							typeof summary.transactionCount === "number"
								? summary.transactionCount
								: 0,
						canonicalKeyCount: Array.isArray(summary.canonicalKeys)
							? summary.canonicalKeys.length
							: 0,
						cadence: summary.cadence ?? null,
						amountBand: summary.amountBand ?? null,
						nextExpectedAt: summary.nextExpectedAt ?? null,
						lastAmountMinor:
							typeof summary.lastAmountMinor === "number"
								? summary.lastAmountMinor
								: null,
						firstSeenAt: row.first_seen_at,
						lastSeenAt: row.last_seen_at,
						summary,
					};
				});
			const latestExport = exportRuns[0] ?? null;

			return {
				year: selectedYear,
				availableYears,
				filters: {
					accountId: input.accountId ?? null,
					institutionId: input.institutionId ?? null,
					ownerIdentityId: input.ownerIdentityId ?? null,
					sourceKind: input.sourceKind ?? null,
					accounts: accountRows.map((row) => ({
						id: row.id,
						label: row.label,
					})),
					institutions: institutionIds.map((id) => ({
						id,
						label: id,
					})),
					ownerIdentities: ownerIdentityIds.map((id) => ({
						id,
						label: id,
					})),
					sourceKinds,
				},
				registry,
				coverage,
				readiness,
				pipelineStatus: {
					rootFinanceRelevantCount: coverage.rootFinanceRelevantCount,
					financeHeadCount: coverage.totalHeads,
					financeV2HeadCount: coverage.financeV2HeadCount,
					financeV3HeadCount: coverage.financeV3HeadCount,
					ledgerEntryCount: coverage.ledgerEntryCount,
					ledgerReadyCount: coverage.ledgerReadyCount,
					ledgerReviewCount: coverage.ledgerReviewCount,
					ledgerBlockedCount: coverage.ledgerBlockedCount,
					patternCount: coverage.patternCount,
					knowledgeMaterialized:
						coverage.ledgerEntryCount > 0 || coverage.patternCount > 0,
					registryImportedAt: registry.importedAt,
					jobs: jobCounts,
				},
				laneProgress,
				summary,
				cashflowSeries,
				categoryBreakdown,
				subscriptionPatterns,
				exportHealth: {
					readyCount: coverage.ledgerReadyCount,
					reviewCount: coverage.ledgerReviewCount,
					blockedCount: coverage.ledgerBlockedCount,
					duplicateCount: coverage.ledgerDuplicateCount,
					latestExport: latestExport
						? {
								id: latestExport.id,
								status: latestExport.status,
								strict: Boolean(latestExport.strict),
								year: latestExport.year,
								outDir: latestExport.out_dir,
								itemCount: exportItemCounts.get(latestExport.id) ?? 0,
								createdAt: latestExport.created_at,
								completedAt: latestExport.completed_at,
								validation: safeJsonParse<Record<string, unknown> | null>(
									latestExport.validation_json,
									null,
								),
							}
						: null,
				},
				rollups: (hasGranularFilters
					? derivedRollups.rollups
					: refreshedRollupRows
							.filter((row) => row.year === selectedYear)
							.map((row) => ({
								year: row.year,
								sourceKind: row.source_kind,
								primaryCategory: row.primary_category,
								inflowMinor: row.inflow_minor,
								outflowMinor: row.outflow_minor,
								netMinor: row.net_minor,
								transactionCount: row.transaction_count,
								importedStatementCount: row.imported_statement_count,
								extractedTransactionCount: row.extracted_transaction_count,
								uncategorizedCount: row.uncategorized_count,
							}))) as Array<{
					year: number;
					sourceKind: string;
					primaryCategory: string;
					inflowMinor: number;
					outflowMinor: number;
					netMinor: number;
					transactionCount: number;
					importedStatementCount: number;
					extractedTransactionCount: number;
					uncategorizedCount: number;
				}>,
				subcategoryRollups: (hasGranularFilters
					? derivedRollups.subcategoryRollups
					: refreshedSubcategoryRows
							.filter((row) => row.year === selectedYear)
							.map((row) => ({
								year: row.year,
								sourceKind: row.source_kind,
								primaryCategory: row.primary_category,
								secondaryCategory: row.secondary_category,
								inflowMinor: row.inflow_minor,
								outflowMinor: row.outflow_minor,
								netMinor: row.net_minor,
								transactionCount: row.transaction_count,
							}))) as Array<{
					year: number;
					sourceKind: string;
					primaryCategory: string;
					secondaryCategory: string;
					inflowMinor: number;
					outflowMinor: number;
					netMinor: number;
					transactionCount: number;
				}>,
				ledgerPreview: filteredLedger.slice(0, 100),
				reviewRows: filteredLedger
					.filter((row) => row.status !== "ready")
					.slice(0, 100),
				importTransactions: filteredImportTransactions
					.slice(0, 100)
					.map((row) => ({
						id: row.id,
						importRunId: row.import_run_id,
						sourceKind: row.source_kind,
						sourceDocumentRef: row.source_document_ref,
						occurredAt: row.occurred_at,
						postedAt: row.posted_at,
						clearedAt: row.cleared_at,
						amountValue: row.amount_value,
						currency: row.currency,
						direction: row.direction,
						description: row.description,
						counterparty: row.merchant_or_counterparty,
						externalTransactionId: row.external_transaction_id,
						statementRowId: row.statement_row_id,
						rowIndex: row.row_index,
						accountMappingKey: row.account_mapping_key,
						bookHint: row.book_hint,
						extractionConfidence: row.extraction_confidence,
						createdAt: row.created_at,
					})),
				importedDocuments: filteredImportDocuments.slice(0, 50).map((row) => ({
					id: row.id,
					documentType: row.document_type,
					issuer: row.issuer,
					externalId: row.external_id,
					statementPeriodStart: row.statement_period_start,
					statementPeriodEnd: row.statement_period_end,
					dueAt: row.due_at,
					taxYear: row.tax_year,
					ownerIdentityHint: row.owner_identity_hint,
					financialAccountHint: row.financial_account_hint,
					institutionHint: row.institution_hint,
					evidenceText: row.evidence_text,
				})),
				exportRuns: exportRuns.map((row) => ({
					id: row.id,
					status: row.status,
					strict: Boolean(row.strict),
					year: row.year,
					outDir: row.out_dir,
					itemCount: exportItemCounts.get(row.id) ?? 0,
					package: safeJsonParse<Record<string, unknown> | null>(
						row.package_json,
						null,
					),
					validation: safeJsonParse<Record<string, unknown> | null>(
						row.validation_json,
						null,
					),
					createdAt: row.created_at,
					completedAt: row.completed_at,
				})),
				patterns: patternRows.map((row) => ({
					id: row.id,
					patternKind: row.pattern_kind,
					patternKey: row.pattern_key,
					status: row.status,
					confidence: row.confidence,
					summary: safeJsonParse(row.summary_json, null),
					firstSeenAt: row.first_seen_at,
					lastSeenAt: row.last_seen_at,
				})),
				accountMappings: mappingRows.map((row) => ({
					id: row.id,
					mappingKey: row.mapping_key,
					book: row.book,
					debitAccount: row.debit_account,
					creditAccount: row.credit_account,
					currency: row.currency,
					confidence: row.confidence,
					match: safeJsonParse(row.match_json, {}),
					notes: row.notes,
				})),
				reviewFindings: reviewFindingRows.map((row) => ({
					targetKind: row.target_kind,
					targetId: row.target_id,
					severity: row.severity,
					action: row.action,
					status: row.status,
					confidence: row.confidence,
					reason: row.reason,
					evidenceRefs: safeJsonParse(row.evidence_refs_json, []),
					updatedAt: row.updated_at,
				})),
				taxReportRuns: taxReportRows.map((row) => ({
					id: row.id,
					status: row.status,
					reportKind: row.report_kind,
					year: row.year,
					quarter: row.quarter,
					businessSlug: row.business_slug,
					outDir: row.out_dir,
					manifest: safeJsonParse(row.manifest_json, null),
					validation: safeJsonParse(row.validation_json, null),
					createdAt: row.created_at,
					completedAt: row.completed_at,
				})),
				registrySuggestions: filteredSuggestionRows.map((row) => ({
					id: row.id,
					entityKind: row.entity_kind,
					canonicalKey: row.canonical_key,
					sourceKind: row.source_kind,
					confidence: row.confidence,
					status: row.status,
					appliedRegistryId: row.applied_registry_id,
					suggestion: safeJsonParse(row.suggestion_json, null),
					updatedAt: row.updated_at,
				})),
				eventCandidates: [],
				documentCandidates: [],
			};
		},
		summarize: (result) => ({
			year: result.year,
			ledger_entries: result.ledgerPreview.length,
			review_rows: result.reviewRows.length,
			exports: result.exportRuns.length,
			finance_heads: result.coverage.totalHeads,
			rollups: result.rollups.length,
			lanes: result.laneProgress.length,
		}),
	});
}

export async function enqueueOverseerCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "enqueueOverseerCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			const { queueJob } = await import("#/lib/jobs");
			return queueJob({
				kind: "rebuild_overseer",
				scopeType: "account",
				scopeId: input.accountId,
				model: APP_CONFIG.fallbackModel,
				promptVersion: OVERSEER_PROMPT_VERSION,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function resolveReviewCommand(input: {
	reviewId: string;
	action: "accept" | "override";
	override?: unknown;
	note?: string;
}) {
	return runLoggedAction({
		operation: "resolveReviewCommand",
		kind: "command",
		context: {
			review_id: input.reviewId,
			review_action: input.action,
		},
		run: async (trace) => {
			const [{ getDb, safeJsonParse }, { nowIso }] = await Promise.all([
				bootServer(),
				import("#/lib/config"),
			]);
			const { publishActionEvent } = await import("#/lib/runtime-events");
			const { queueJobIdempotent } = await import("#/lib/jobs");
			const db = getDb();

			const review = await db
				.selectFrom("reviews")
				.innerJoin("messages", "messages.id", "reviews.message_id")
				.select([
					"reviews.message_id as message_id",
					"messages.account_id as account_id",
				])
				.where("reviews.id", "=", input.reviewId)
				.executeTakeFirstOrThrow();
			trace.add({
				message_id: review.message_id,
				account_id: review.account_id,
			});

			if (input.action === "accept") {
				await db
					.updateTable("reviews")
					.set({
						status: "resolved",
						reviewer_note: input.note ?? null,
						resolved_at: nowIso(),
					})
					.where("id", "=", input.reviewId)
					.execute();
				const currentLabel = await db
					.selectFrom("message_labels")
					.select(["label_json"])
					.where("message_id", "=", review.message_id)
					.executeTakeFirst();
				if (
					parseFinanceRelevant(safeJsonParse, currentLabel?.label_json ?? null)
				) {
					await queueFinanceBacklogJob(review.account_id);
				}
				await publishActionEvent({
					topic: "reviews",
					eventType: "review.updated",
					entityKind: "review",
					entityId: input.reviewId,
					payload: {
						reviewId: input.reviewId,
						messageId: review.message_id,
						status: "resolved",
						action: "accept",
					},
				});
				await queueJobIdempotent({
					kind: "rebuild_overseer",
					scopeType: "account",
					scopeId: review.account_id,
					model: APP_CONFIG.fallbackModel,
					promptVersion: OVERSEER_PROMPT_VERSION,
				});
				return { status: "accepted" as const };
			}

			if (!input.override) {
				throw new Error("Override label is required for override action");
			}

			const { normalizeManualOverrideLabel, writeManualOverride } =
				await import("#/lib/classify");
			const overrideLabel = normalizeManualOverrideLabel(input.override);
			await writeManualOverride({
				reviewId: input.reviewId,
				messageId: review.message_id,
				note: input.note ?? null,
				label: overrideLabel,
			});
			if (overrideLabel.finance.relevant) {
				await queueFinanceBacklogJob(review.account_id);
			} else {
				await queueFinanceKnowledgeJob();
			}
			await publishActionEvent({
				topic: "reviews",
				eventType: "review.updated",
				entityKind: "review",
				entityId: input.reviewId,
				payload: {
					reviewId: input.reviewId,
					messageId: review.message_id,
					status: "resolved",
					action: "override",
				},
			});
			await queueJobIdempotent({
				kind: "rebuild_overseer",
				scopeType: "account",
				scopeId: review.account_id,
				model: APP_CONFIG.fallbackModel,
				promptVersion: OVERSEER_PROMPT_VERSION,
			});
			return { status: "overridden" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function classifyOneNowCommand(input: { messageId: string }) {
	return runLoggedAction({
		operation: "classifyOneNowCommand",
		kind: "command",
		context: {
			message_id: input.messageId,
		},
		run: async (trace) => {
			const { getDb } = await bootServer();
			const db = getDb();
			const message = await db
				.selectFrom("messages")
				.select(["messages.id", "messages.account_id"])
				.where("messages.id", "=", input.messageId)
				.executeTakeFirstOrThrow();
			trace.add({
				message_id: message.id,
				account_id: message.account_id,
			});
			const { queueJobIdempotent } = await import("#/lib/jobs");
			const jobId = await queueJobIdempotent({
				kind: "classify_root_messages",
				scopeType: "account",
				scopeId: message.account_id,
				model: APP_CONFIG.classifierModel,
				promptVersion: CLASSIFY_PROMPT_VERSION,
				meta: { targetMessageIds: [message.id] },
			});
			return { status: "queued" as const, jobId };
		},
		summarize: (result) => ({
			status: result.status,
			job_id: result.jobId ?? undefined,
		}),
	});
}

export async function loadAccountsData() {
	return runLoggedAction({
		operation: "loadAccountsData",
		kind: "loader",
		run: async () => {
			const [{ getDb }, { readOAuthToken }] = await Promise.all([
				bootServer(),
				import("#/lib/google-oauth"),
			]);
			const db = getDb();
			const [accounts, messageCounts, tombstoneCounts] = await Promise.all([
				db.selectFrom("accounts").selectAll().orderBy("label").execute(),
				db
					.selectFrom("messages")
					.select(["account_id", (eb) => eb.fn.countAll<number>().as("count")])
					.groupBy("account_id")
					.execute(),
				db
					.selectFrom("message_sources")
					.select(["account_id", (eb) => eb.fn.countAll<number>().as("count")])
					.where("state", "=", "tombstoned")
					.groupBy("account_id")
					.execute(),
			]);

			const messageCountsByAccount = new Map(
				messageCounts.map((row) => [row.account_id, Number(row.count)]),
			);
			const tombstoneCountsByAccount = new Map(
				tombstoneCounts.map((row) => [row.account_id, Number(row.count)]),
			);

			return {
				accounts: accounts.map((account) => {
					const hasOAuthToken = Boolean(readOAuthToken(account.id));
					return {
						...account,
						has_oauth_token: hasOAuthToken,
						connection_state: deriveAccountConnectionState(
							account,
							hasOAuthToken,
						),
						message_count: messageCountsByAccount.get(account.id) ?? 0,
						tombstone_count: tombstoneCountsByAccount.get(account.id) ?? 0,
					};
				}),
			};
		},
		summarize: (result) => ({
			accounts: result.accounts.length,
		}),
	});
}

export async function loadAccountNewData() {
	return runLoggedAction({
		operation: "loadAccountNewData",
		kind: "loader",
		run: async () => {
			await bootServer();
			return loadGoogleOAuthReadiness();
		},
		summarize: (result) => ({
			oauth_ready: result.oauthReady,
			missing_vars: result.missingVars.length,
		}),
	});
}

export async function loadAccountDetailData(input: { accountId: string }) {
	return runLoggedAction({
		operation: "loadAccountDetailData",
		kind: "loader",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const [{ safeJsonParse }, accountState] = await Promise.all([
				bootServer(),
				loadAccountConnectionState(input.accountId),
			]);
			const db = accountState.db;
			const [
				syncState,
				recentJobs,
				msgCount,
				tombCount,
				financeCoverage,
				syncProgress,
				laneProgress,
			] = await Promise.all([
				db
					.selectFrom("account_sync_state")
					.selectAll()
					.where("account_id", "=", input.accountId)
					.executeTakeFirst(),
				db
					.selectFrom("jobs")
					.select(["id", "kind", "status", "created_at", "last_error"])
					.where("scope_type", "=", "account")
					.where("scope_id", "=", input.accountId)
					.orderBy("created_at", "desc")
					.limit(10)
					.execute(),
				db
					.selectFrom("messages")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.where("account_id", "=", input.accountId)
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("message_sources")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.where("account_id", "=", input.accountId)
					.where("state", "=", "tombstoned")
					.executeTakeFirstOrThrow(),
				loadFinanceCoverageSummary({
					db,
					safeJsonParse,
					accountId: input.accountId,
				}),
				import("#/lib/sync-progress").then((module) =>
					module.loadAccountSyncProgress(input.accountId),
				),
				import("#/lib/job-lane-progress").then((module) =>
					module.loadAccountLaneProgress(input.accountId),
				),
			]);

			return {
				account: {
					...accountState.account,
					has_oauth_token: accountState.hasOAuthToken,
					connection_state: accountState.connectionState,
				},
				has_oauth_token: accountState.hasOAuthToken,
				connection_state: accountState.connectionState,
				financeCoverage,
				syncProgress,
				laneProgress,
				syncState: syncState ?? null,
				recentJobs,
				messageCount: Number(msgCount.count),
				tombstoneCount: Number(tombCount.count),
			};
		},
		summarize: (result) => ({
			message_count: result.messageCount,
			tombstone_count: result.tombstoneCount,
			recent_jobs: result.recentJobs.length,
			has_sync_state: Boolean(result.syncState),
			root_finance_relevant: result.financeCoverage.rootFinanceRelevantCount,
		}),
	});
}

export async function loadAccountReconnectData(input: { accountId: string }) {
	return runLoggedAction({
		operation: "loadAccountReconnectData",
		kind: "loader",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const [accountState, oauthReadiness] = await Promise.all([
				loadAccountConnectionState(input.accountId),
				loadGoogleOAuthReadiness(),
			]);

			return {
				account: {
					...accountState.account,
					has_oauth_token: accountState.hasOAuthToken,
					connection_state: accountState.connectionState,
				},
				has_oauth_token: accountState.hasOAuthToken,
				connection_state: accountState.connectionState,
				...oauthReadiness,
			};
		},
		summarize: (result) => ({
			connection_state: result.connection_state,
			has_oauth_token: result.has_oauth_token,
			oauth_ready: result.oauthReady,
		}),
	});
}

export async function loadAccountDeleteData(input: { accountId: string }) {
	return runLoggedAction({
		operation: "loadAccountDeleteData",
		kind: "loader",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const accountState = await loadAccountConnectionState(input.accountId);
			const db = accountState.db;
			const [msgCount, tombCount, runningJobs] = await Promise.all([
				db
					.selectFrom("messages")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.where("account_id", "=", input.accountId)
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("message_sources")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.where("account_id", "=", input.accountId)
					.where("state", "=", "tombstoned")
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("jobs")
					.select(["id", "kind", "status", "created_at"])
					.where("scope_type", "=", "account")
					.where("scope_id", "=", input.accountId)
					.where("status", "=", "running")
					.orderBy("created_at", "desc")
					.limit(10)
					.execute(),
			]);

			return {
				account: {
					...accountState.account,
					has_oauth_token: accountState.hasOAuthToken,
					connection_state: accountState.connectionState,
				},
				has_oauth_token: accountState.hasOAuthToken,
				connection_state: accountState.connectionState,
				messageCount: Number(msgCount.count),
				tombstoneCount: Number(tombCount.count),
				runningJobs,
			};
		},
		summarize: (result) => ({
			connection_state: result.connection_state,
			message_count: result.messageCount,
			tombstone_count: result.tombstoneCount,
			running_jobs: result.runningJobs.length,
		}),
	});
}

export async function beginGoogleConnectCommand(input: {
	label: string;
	ownerPrincipalEmail: string;
}) {
	return runLoggedAction({
		operation: "beginGoogleConnectCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			const { buildAuthUrl } = await import("#/lib/google-oauth");
			return buildAuthUrl({
				label: input.label,
				flow: "connect",
				ownerPrincipalEmail: normalizeOwnerPrincipalEmail(
					input.ownerPrincipalEmail,
				),
			});
		},
		summarize: () => ({
			oauth_redirect_prepared: true,
		}),
	});
}

export async function beginGoogleReconnectCommand(input: {
	accountId: string;
	label: string;
}) {
	return runLoggedAction({
		operation: "beginGoogleReconnectCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { account } = await loadAccountConnectionState(input.accountId);
			if (account.provider_kind !== "gmail") {
				throw new Error("Only Gmail accounts can be reconnected.");
			}
			const { buildAuthUrl } = await import("#/lib/google-oauth");
			return buildAuthUrl({
				label: input.label,
				flow: "reconnect",
				accountId: input.accountId,
			});
		},
		summarize: () => ({
			oauth_redirect_prepared: true,
		}),
	});
}

export async function completeGoogleConnectCommand(input: {
	code: string;
	state: string;
}) {
	return runLoggedAction({
		operation: "completeGoogleConnectCommand",
		kind: "command",
		run: async (trace) => {
			const [{ getDb }, { nowIso }] = await Promise.all([
				bootServer(),
				import("#/lib/config"),
			]);
			const db = getDb();
			const oauth = await import("#/lib/google-oauth");

			const oauthState = oauth.loadOAuthState(input.state);
			if (!oauthState) {
				throw new Error("Invalid or expired OAuth state");
			}

			const tokens = await oauth.exchangeCode(
				input.code,
				oauthState.codeVerifier,
			);
			const normalizedEmail = (
				await oauth.fetchEmailIdentity(tokens.access_token)
			)
				.trim()
				.toLowerCase();
			const record = oauth.buildOAuthRecord(normalizedEmail, tokens);
			const now = nowIso();
			const flow = oauthState.flow ?? "connect";

			let accountId: string;
			if (flow === "reconnect") {
				if (!oauthState.accountId) {
					throw new Error("Invalid reconnect OAuth state");
				}
				const reconnectAccount = await db
					.selectFrom("accounts")
					.select(["id", "email_address", "provider_kind", "selected_mailbox"])
					.where("id", "=", oauthState.accountId)
					.executeTakeFirst();
				if (!reconnectAccount || reconnectAccount.provider_kind !== "gmail") {
					throw new Error("The selected Gmail account no longer exists.");
				}
				if (
					reconnectAccount.email_address.trim().toLowerCase() !==
					normalizedEmail
				) {
					throw new Error(
						"Reconnect failed: you chose the wrong Gmail identity during reconnect.",
					);
				}

				await db
					.updateTable("accounts")
					.set({
						label: oauthState.label,
						sync_enabled: 1,
						sync_status: "idle",
						last_error: null,
						updated_at: now,
					})
					.where("id", "=", reconnectAccount.id)
					.execute();

				accountId = reconnectAccount.id;
			} else {
				const ownerPrincipalEmail =
					typeof oauthState.ownerPrincipalEmail === "string"
						? normalizeOwnerPrincipalEmail(oauthState.ownerPrincipalEmail)
						: "";
				if (!ownerPrincipalEmail) {
					throw new Error("Invalid connect OAuth state");
				}
				const existingAccount = await db
					.selectFrom("accounts")
					.select(["id", "selected_mailbox", "owner_principal_email"])
					.where("email_address", "=", normalizedEmail)
					.executeTakeFirst();
				const existingOwnerPrincipalEmail =
					existingAccount?.owner_principal_email?.trim()
						? normalizeOwnerPrincipalEmail(
								existingAccount.owner_principal_email,
							)
						: null;
				if (
					existingOwnerPrincipalEmail &&
					existingOwnerPrincipalEmail !== ownerPrincipalEmail
				) {
					throw new Error(
						"This Gmail account is already linked to another zmail owner.",
					);
				}
				const resolvedOwnerPrincipalEmail =
					existingOwnerPrincipalEmail ?? ownerPrincipalEmail;
				const selectedMailbox =
					existingAccount?.selected_mailbox?.trim() || "[Gmail]/All Mail";
				await db
					.insertInto("accounts")
					.values({
						id: existingAccount?.id ?? crypto.randomUUID(),
						label: oauthState.label,
						email_address: normalizedEmail,
						owner_principal_email: resolvedOwnerPrincipalEmail,
						provider_kind: "gmail",
						sync_enabled: 1,
						sync_status: "idle",
						source_truth: "corpus_mirror",
						selected_mailbox: selectedMailbox,
						last_synced_at: null,
						last_error: null,
						created_at: now,
						updated_at: now,
					})
					.onConflict((oc) =>
						oc.column("email_address").doUpdateSet({
							label: oauthState.label,
							provider_kind: "gmail",
							owner_principal_email: resolvedOwnerPrincipalEmail,
							sync_enabled: 1,
							sync_status: "idle",
							source_truth: "corpus_mirror",
							selected_mailbox: selectedMailbox,
							last_error: null,
							updated_at: now,
						}),
					)
					.execute();

				const account = await db
					.selectFrom("accounts")
					.select(["id"])
					.where("email_address", "=", normalizedEmail)
					.executeTakeFirstOrThrow();
				accountId = account.id;
			}
			trace.add({
				account_id: accountId,
			});

			oauth.writeOAuthToken(accountId, record);

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
					consecutive_failures: 0,
					backoff_until: null,
					created_at: now,
					updated_at: now,
				})
				.onConflict((oc) =>
					oc.column("account_id").doUpdateSet({
						updated_at: now,
					}),
				)
				.execute();

			const { queueJobIdempotent } = await import("#/lib/jobs");
			await queueJobIdempotent({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: accountId,
			});

			return { accountId };
		},
		summarize: (result) => ({
			account_id: result.accountId,
		}),
	});
}

export async function queueAccountFullSyncCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountFullSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await assertRemoteSyncCommandAllowed(input.accountId);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: input.accountId,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountDeltaSyncCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountDeltaSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await assertRemoteSyncCommandAllowed(input.accountId);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "sync_account_delta",
				scopeType: "account",
				scopeId: input.accountId,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountReconcileCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountReconcileCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await assertRemoteSyncCommandAllowed(input.accountId);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "sync_account_reconcile",
				scopeType: "account",
				scopeId: input.accountId,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountClassifyBacklogCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountClassifyBacklogCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "classify_account_backlog",
				scopeType: "account",
				scopeId: input.accountId,
				model: APP_CONFIG.classifierModel,
				promptVersion: CLASSIFY_PROMPT_VERSION,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueTargetedRootMessagesCommand(input: {
	accountId: string;
	messageIds: string[];
}) {
	return runLoggedAction({
		operation: "queueTargetedRootMessagesCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			const messageIds = Array.from(
				new Set(input.messageIds.map((value) => value.trim()).filter(Boolean)),
			);
			if (messageIds.length === 0) {
				throw new Error("messageIds is required");
			}
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "classify_root_messages",
				scopeType: "account",
				scopeId: input.accountId,
				model: APP_CONFIG.classifierModel,
				promptVersion: CLASSIFY_PROMPT_VERSION,
				meta: { targetMessageIds: messageIds },
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountFinanceBacklogCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountFinanceBacklogCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			return queueFinanceBacklogJob(input.accountId);
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueReviewClassifierCommand(input?: {
	accountId?: string;
	limit?: number;
}) {
	return runLoggedAction({
		operation: "queueReviewClassifierCommand",
		kind: "command",
		context: {
			account_id: input?.accountId,
		},
		run: async () => {
			await bootServer();
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "classify_review_backlog",
				scopeType: input?.accountId ? "account" : "system",
				scopeId: input?.accountId ?? "review_classifier",
				model: APP_CONFIG.classifierModel,
				promptVersion: REVIEW_CLASSIFIER_PROMPT_VERSION,
				meta: {
					...(input?.accountId ? { accountId: input.accountId } : {}),
					...(input?.limit ? { limit: input.limit } : {}),
				},
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueImportOperatorRegistryCommand() {
	return runLoggedAction({
		operation: "queueImportOperatorRegistryCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "import_operator_registry",
				scopeType: "system",
				scopeId: "operator_registry",
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueRebuildFinanceKnowledgeCommand() {
	return runLoggedAction({
		operation: "queueRebuildFinanceKnowledgeCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			return queueFinanceKnowledgeJob();
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueRebuildFinanceRollupsCommand() {
	return runLoggedAction({
		operation: "queueRebuildFinanceRollupsCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			return queueFinanceRollupsJob();
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

function resolveFinanceExportOutDir(input: {
	exportRoot: string;
	orgId: string;
	exportRunId: string;
	requestedOutDir?: string | null;
}) {
	const requested = input.requestedOutDir?.trim();
	if (!requested) {
		return resolve(input.exportRoot, input.orgId, input.exportRunId);
	}
	if (isAbsolute(requested)) {
		throw new Error(
			"Finance export outDir must be a relative path inside the org finance export directory.",
		);
	}
	const outDir = resolve(input.exportRoot, requested);
	const relativeOutDir = relative(input.exportRoot, outDir);
	if (
		relativeOutDir === ".." ||
		relativeOutDir.startsWith("../") ||
		relativeOutDir.startsWith("..\\") ||
		isAbsolute(relativeOutDir)
	) {
		throw new Error(
			"Finance export outDir must stay inside the org finance export directory.",
		);
	}
	return outDir;
}

export async function queueFinanceExportCommand(input: {
	year?: number | null;
	outDir?: string | null;
	strict?: boolean;
	force?: boolean;
}) {
	return runLoggedAction({
		operation: "queueFinanceExportCommand",
		kind: "command",
		run: async () => {
			const [{ getDb, jsonText }, { nowIso }, { queueJob }, runtime] =
				await Promise.all([
					bootServer(),
					import("#/lib/config"),
					import("#/lib/jobs"),
					import("#/lib/runtime"),
				]);
			const orgId = runtime.currentOrgId();
			const exportRunId = randomUUID();
			const strict = input.strict ?? true;
			const force = input.force ?? false;
			const year = input.year ?? null;
			const exportRoot = resolve(
				runtime.runtimePaths(orgId).operatorDir,
				"exports",
				"finance",
			);
			const outDir = resolveFinanceExportOutDir({
				exportRoot,
				orgId,
				exportRunId,
				requestedOutDir: input.outDir,
			});
			const createdAt = nowIso();
			await getDb()
				.insertInto("finance_export_runs")
				.values({
					id: exportRunId,
					status: "queued",
					strict: strict ? 1 : 0,
					year,
					out_dir: outDir,
					package_json: jsonText({}),
					validation_json: jsonText({}),
					created_at: createdAt,
					completed_at: null,
				})
				.execute();
			const jobId = await queueJob({
				kind: "export_finance_beancount",
				scopeType: "system",
				scopeId: exportRunId,
				meta: {
					orgId,
					exportRunId,
					outDir,
					year,
					strict,
					force,
				},
			});
			return { jobId, exportRunId, outDir };
		},
		summarize: (result) => ({
			job_id: result.jobId,
			export_run_id: result.exportRunId,
			out_dir: result.outDir,
		}),
	});
}

function resolveFinanceReportOutDir(input: {
	reportRoot: string;
	requestedOutDir?: string | null;
}) {
	const requested = input.requestedOutDir?.trim();
	if (!requested) {
		return null;
	}
	if (isAbsolute(requested)) {
		throw new Error(
			"Finance report outDir must be a relative path inside the org finance report directory.",
		);
	}
	const outDir = resolve(input.reportRoot, requested);
	const relativeOutDir = relative(input.reportRoot, outDir);
	if (
		relativeOutDir === ".." ||
		relativeOutDir.startsWith("../") ||
		relativeOutDir.startsWith("..\\") ||
		isAbsolute(relativeOutDir)
	) {
		throw new Error(
			"Finance report outDir must stay inside the org finance report directory.",
		);
	}
	return outDir;
}

export async function upsertFinanceMappingCommand(input: { mapping: unknown }) {
	return runLoggedAction({
		operation: "upsertFinanceMappingCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			const [
				{ financeAccountMappingSchema },
				{ upsertFinanceAccountMappingYaml },
			] = await Promise.all([
				import("#/lib/schemas"),
				import("#/lib/registry"),
			]);
			const mapping = financeAccountMappingSchema.parse(input.mapping);
			const result = upsertFinanceAccountMappingYaml(mapping);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			const importJobId = await queueJobIdempotent({
				kind: "import_operator_registry",
				scopeType: "system",
				scopeId: "operator_registry",
				meta: {
					source: "finance_mapping_upsert",
					mappingKey: mapping.mappingKey,
				},
			});
			await Promise.all([queueFinanceKnowledgeJob(), queueFinanceRollupsJob()]);
			return {
				...result,
				importJobId,
			};
		},
		summarize: (result) => ({
			mapping_key: result.mappingKey,
			import_job_id: result.importJobId ?? undefined,
		}),
	});
}

export async function queueTaxPersonalPackageCommand(input: {
	year: number;
	outDir?: string | null;
}) {
	return runLoggedAction({
		operation: "queueTaxPersonalPackageCommand",
		kind: "command",
		run: async () => {
			const [{ getDb, jsonText }, { nowIso }, { queueJob }, runtime] =
				await Promise.all([
					bootServer(),
					import("#/lib/config"),
					import("#/lib/jobs"),
					import("#/lib/runtime"),
				]);
			const orgId = runtime.currentOrgId();
			const reportRunId = randomUUID();
			const reportRoot = resolve(
				runtime.runtimePaths(orgId).operatorDir,
				"reports",
				"tax",
			);
			const outDir = resolveFinanceReportOutDir({
				reportRoot,
				requestedOutDir: input.outDir,
			});
			const createdAt = nowIso();
			await getDb()
				.insertInto("tax_report_runs")
				.values({
					id: reportRunId,
					status: "queued",
					report_kind: "personal_annual",
					year: input.year,
					quarter: null,
					business_slug: null,
					out_dir: outDir ?? "",
					manifest_json: jsonText({}),
					validation_json: jsonText({}),
					created_at: createdAt,
					completed_at: null,
				})
				.execute();
			const jobId = await queueJob({
				kind: "generate_tax_personal_package",
				scopeType: "system",
				scopeId: reportRunId,
				meta: {
					reportRunId,
					year: input.year,
					outDir,
				},
			});
			return { jobId, reportRunId, outDir };
		},
		summarize: (result) => ({
			job_id: result.jobId,
			report_run_id: result.reportRunId,
		}),
	});
}

export async function queueTaxBusinessQuarterPackageCommand(input: {
	year: number;
	quarter: number;
	businessSlug?: "inherent-design";
	outDir?: string | null;
}) {
	return runLoggedAction({
		operation: "queueTaxBusinessQuarterPackageCommand",
		kind: "command",
		run: async () => {
			const [{ getDb, jsonText }, { nowIso }, { queueJob }, runtime] =
				await Promise.all([
					bootServer(),
					import("#/lib/config"),
					import("#/lib/jobs"),
					import("#/lib/runtime"),
				]);
			const orgId = runtime.currentOrgId();
			const reportRunId = randomUUID();
			const reportRoot = resolve(
				runtime.runtimePaths(orgId).operatorDir,
				"reports",
				"tax",
			);
			const outDir = resolveFinanceReportOutDir({
				reportRoot,
				requestedOutDir: input.outDir,
			});
			const createdAt = nowIso();
			await getDb()
				.insertInto("tax_report_runs")
				.values({
					id: reportRunId,
					status: "queued",
					report_kind: "business_quarter",
					year: input.year,
					quarter: input.quarter,
					business_slug: input.businessSlug ?? "inherent-design",
					out_dir: outDir ?? "",
					manifest_json: jsonText({}),
					validation_json: jsonText({}),
					created_at: createdAt,
					completed_at: null,
				})
				.execute();
			const jobId = await queueJob({
				kind: "generate_tax_business_quarter_package",
				scopeType: "system",
				scopeId: reportRunId,
				meta: {
					reportRunId,
					year: input.year,
					quarter: input.quarter,
					businessSlug: input.businessSlug ?? "inherent-design",
					outDir,
				},
			});
			return { jobId, reportRunId, outDir };
		},
		summarize: (result) => ({
			job_id: result.jobId,
			report_run_id: result.reportRunId,
		}),
	});
}

export async function queueReconcileRegistrySuggestionsCommand() {
	return runLoggedAction({
		operation: "queueReconcileRegistrySuggestionsCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			return queueRegistrySuggestionReconcileJob();
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueImportFinanceArtifactCommand(input: {
	artifact: unknown;
}) {
	return runLoggedAction({
		operation: "queueImportFinanceArtifactCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			const { financeSourceImportSchema } = await import("#/lib/schemas");
			const { computeArtifactSha256 } = await import("#/lib/finance-imports");
			const artifact = financeSourceImportSchema.parse(input.artifact);
			const artifactSha256 = computeArtifactSha256(artifact);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "import_finance_artifact",
				scopeType: "system",
				scopeId: artifactSha256,
				meta: { artifact },
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueReclassifyRootBacklogCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueReclassifyRootBacklogCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "classify_account_backlog",
				scopeType: "account",
				scopeId: input.accountId,
				model: APP_CONFIG.classifierModel,
				promptVersion: CLASSIFY_PROMPT_VERSION,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueReclassifyFinanceBacklogCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueReclassifyFinanceBacklogCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			return queueFinanceBacklogJob(input.accountId);
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function pauseAccountSyncCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "pauseAccountSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const { nowIso } = await import("#/lib/config");
			const { stopWatcher } = await import("#/lib/watchers");
			const db = getDb();
			await stopWatcher(input.accountId);
			await db
				.updateTable("accounts")
				.set({
					sync_enabled: 0,
					sync_status: "paused",
					updated_at: nowIso(),
				})
				.where("id", "=", input.accountId)
				.execute();
			return { status: "paused" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function resumeAccountSyncCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "resumeAccountSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const { nowIso } = await import("#/lib/config");
			const { queueJobIdempotent } = await import("#/lib/jobs");
			const { startWatcher } = await import("#/lib/watchers");
			const db = getDb();
			const syncState = await db
				.selectFrom("account_sync_state")
				.select([
					"backfill_next_uid",
					"last_bootstrap_completed_at",
					"account_id",
				])
				.where("account_id", "=", input.accountId)
				.executeTakeFirst();
			const nextStatus =
				syncState?.backfill_next_uid !== null &&
				syncState?.backfill_next_uid !== undefined
					? "backfilling"
					: "idle";
			await db
				.updateTable("accounts")
				.set({
					sync_enabled: 1,
					sync_status: nextStatus,
					updated_at: nowIso(),
				})
				.where("id", "=", input.accountId)
				.execute();

			if (!syncState || syncState.last_bootstrap_completed_at === null) {
				await queueJobIdempotent({
					kind: "sync_account_full",
					scopeType: "account",
					scopeId: input.accountId,
				});
			} else {
				await startWatcher(input.accountId);
				if (syncState.backfill_next_uid !== null) {
					await queueJobIdempotent({
						kind: "sync_account_backfill",
						scopeType: "account",
						scopeId: input.accountId,
					});
				}
			}
			return { status: "resumed" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function disconnectAccountCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "disconnectAccountCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const { nowIso } = await import("#/lib/config");
			const { stopWatcher } = await import("#/lib/watchers");
			const { deleteOAuthToken } = await import("#/lib/google-oauth");
			const db = getDb();
			await stopWatcher(input.accountId);
			deleteOAuthToken(input.accountId);
			await db
				.updateTable("accounts")
				.set({
					sync_enabled: 0,
					sync_status: "idle",
					last_error: null,
					updated_at: nowIso(),
				})
				.where("id", "=", input.accountId)
				.execute();
			return { status: "disconnected" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function purgeAccountCommand(input: {
	accountId: string;
	confirmationEmail: string;
}) {
	return runLoggedAction({
		operation: "purgeAccountCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { db, account } = await loadAccountConnectionState(input.accountId);
			if (
				input.confirmationEmail.trim().toLowerCase() !==
				account.email_address.trim().toLowerCase()
			) {
				throw new Error(
					"Confirmation email must match the account email before deletion.",
				);
			}

			const runningJobs = await db
				.selectFrom("jobs")
				.select(["kind"])
				.where("scope_type", "=", "account")
				.where("scope_id", "=", input.accountId)
				.where("status", "=", "running")
				.orderBy("created_at", "desc")
				.execute();
			if (runningJobs.length > 0) {
				throw new Error(
					`Account purge is blocked while jobs are running: ${runningJobs
						.map((job) => job.kind)
						.join(", ")}`,
				);
			}

			const [{ stopWatcher }, { accountDir, accountOAuthPath, accountRawDir }] =
				await Promise.all([import("#/lib/watchers"), import("#/lib/config")]);
			await stopWatcher(input.accountId);

			rmSync(accountOAuthPath(input.accountId), { force: true });
			rmSync(accountRawDir(input.accountId), { recursive: true, force: true });
			rmSync(accountDir(input.accountId), { recursive: true, force: true });

			await db.transaction().execute(async (trx) => {
				await trx
					.deleteFrom("jobs")
					.where("scope_type", "=", "account")
					.where("scope_id", "=", input.accountId)
					.execute();
				await trx
					.deleteFrom("accounts")
					.where("id", "=", input.accountId)
					.executeTakeFirst();
			});

			await Promise.all([queueFinanceKnowledgeJob(), queueFinanceRollupsJob()]);
			return { status: "deleted" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}
