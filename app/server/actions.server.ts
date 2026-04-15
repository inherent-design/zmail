import {
	APP_CONFIG,
	CLASSIFY_PROMPT_VERSION,
	FINANCE_INTEL_PROMPT_VERSION,
	FINANCE_KNOWLEDGE_PROMPT_VERSION,
	OVERSEER_PROMPT_VERSION,
} from "#/lib/config";
import { type LogFields, type LogTrace, startTrace } from "#/lib/log";

let bootServerOnce: Promise<typeof import("#/lib/db")> | null = null;

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
		.innerJoin("messages", "messages.id", "message_secondary_heads.message_id")
		.select([
			"message_secondary_heads.status",
			"message_secondary_heads.message_id",
		])
		.where("message_secondary_heads.classifier_key", "=", "finance_intel");
	let evidenceQuery = input.db
		.selectFrom("finance_event_evidence")
		.innerJoin("messages", "messages.id", "finance_event_evidence.message_id")
		.select([
			"finance_event_evidence.event_candidate_id",
			"finance_event_evidence.document_candidate_id",
		]);

	if (input.accountId) {
		labelQuery = labelQuery.where("messages.account_id", "=", input.accountId);
		headQuery = headQuery.where("messages.account_id", "=", input.accountId);
		evidenceQuery = evidenceQuery.where(
			"messages.account_id",
			"=",
			input.accountId,
		);
	}

	const [labelRows, headRows, evidenceRows] = await Promise.all([
		labelQuery.execute(),
		headQuery.execute(),
		evidenceQuery.execute(),
	]);

	const rootFinanceRelevantCount = labelRows.reduce((count, row) => {
		return (
			count + Number(parseFinanceRelevant(input.safeJsonParse, row.label_json))
		);
	}, 0);

	const statusCounts = createFinanceStatusCounts();
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
	}

	const eventCandidateIds = new Set<string>();
	const documentCandidateIds = new Set<string>();
	for (const row of evidenceRows) {
		if (row.event_candidate_id) {
			eventCandidateIds.add(row.event_candidate_id);
		}
		if (row.document_candidate_id) {
			documentCandidateIds.add(row.document_candidate_id);
		}
	}

	return {
		rootFinanceRelevantCount,
		totalHeads: headRows.length,
		readyCount: statusCounts.ready,
		reviewCount: statusCounts.review,
		staleCount: statusCounts.stale,
		blockedParseErrorCount: statusCounts.blockedParseError,
		eventCandidateCount: eventCandidateIds.size,
		documentCandidateCount: documentCandidateIds.size,
	};
}

async function bootServer() {
	if (!bootServerOnce) {
		bootServerOnce = (async () => {
			const [{ ensureWorkerStarted }, dbModule] = await Promise.all([
				import("#/lib/worker"),
				import("#/lib/db"),
			]);
			dbModule.runMigrations();
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
			const [messages, reviews, jobs, accounts] = await Promise.all([
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
			]);

			return {
				messages: Number(messages.count),
				openReviews: Number(reviews.count),
				jobs: Number(jobs.count),
				accounts: Number(accounts.count),
			};
		},
		summarize: (result) => ({
			messages: result.messages,
			open_reviews: result.openReviews,
			jobs: result.jobs,
			accounts: result.accounts,
		}),
	});
}

export async function loadMessagesData() {
	return runLoggedAction({
		operation: "loadMessagesData",
		kind: "loader",
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const rows = await db
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
				])
				.orderBy("messages.received_at", "desc")
				.limit(250)
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

			return rows.map(({ body_text_forwarded, ...row }) => ({
				...row,
				remote_thread_id:
					sourceByMessageId.get(row.id)?.remote_thread_id ?? null,
				has_forwarded: body_text_forwarded.length > 0,
				label: safeJsonParse(row.label_json ?? null, null),
			}));
		},
		summarize: (result) => ({
			count: result.length,
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

			return rows.map(({ body_text_forwarded, ...row }) => ({
				...row,
				has_forwarded: body_text_forwarded.length > 0,
				result: safeJsonParse(row.result_json, null),
			}));
		},
		summarize: (result) => ({
			count: result.length,
		}),
	});
}

export async function loadRunsData() {
	return runLoggedAction({
		operation: "loadRunsData",
		kind: "loader",
		run: async () => {
			const [{ listJobs }, { getPiStatus }] = await Promise.all([
				import("#/lib/jobs"),
				import("#/lib/pi"),
			]);
			await bootServer();
			const [jobs, runtime] = await Promise.all([listJobs(), getPiStatus()]);
			return {
				jobs,
				runtime,
			};
		},
		summarize: (result) => ({
			jobs: result.jobs.length,
			resolved_backend: result.runtime.resolvedBackend ?? "unavailable",
		}),
	});
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
			const [{ loadCombinedFinanceLedger }, { rebuildFinanceRollups }] =
				await Promise.all([
					import("#/lib/finance-rollups"),
					import("#/lib/finance-rollups"),
				]);
			const db = getDb();
			const [
				registry,
				coverage,
				eventRows,
				documentRows,
				evidenceRows,
				ledger,
				rollupRows,
				subcategoryRows,
				importDocumentRows,
				suggestionRows,
				accountRows,
			] = await Promise.all([
				loadRegistryState(db, safeJsonParse),
				loadFinanceCoverageSummary({ db, safeJsonParse }),
				db
					.selectFrom("finance_event_candidates")
					.selectAll()
					.orderBy("last_message_received_at", "desc")
					.orderBy("updated_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("finance_document_candidates")
					.selectAll()
					.orderBy("last_message_received_at", "desc")
					.orderBy("updated_at", "desc")
					.limit(100)
					.execute(),
				db
					.selectFrom("finance_event_evidence")
					.innerJoin(
						"messages",
						"messages.id",
						"finance_event_evidence.message_id",
					)
					.innerJoin("accounts", "accounts.id", "messages.account_id")
					.select([
						"finance_event_evidence.id",
						"finance_event_evidence.event_candidate_id",
						"finance_event_evidence.document_candidate_id",
						"finance_event_evidence.message_id",
						"finance_event_evidence.transaction_index",
						"finance_event_evidence.document_index",
						"finance_event_evidence.evidence_json",
						"messages.subject",
						"messages.received_at",
						"accounts.label as account_label",
					])
					.orderBy("finance_event_evidence.created_at", "desc")
					.execute(),
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
					.selectAll()
					.orderBy("created_at", "desc")
					.limit(100)
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

			const summary = filteredLedger.reduce(
				(acc, entry) => {
					const amount = entry.amountMinor ?? 0;
					if (entry.direction === "income") {
						acc.inflowMinor += amount;
						acc.netMinor += amount;
					}
					if (entry.direction === "expense") {
						acc.outflowMinor += amount;
						acc.netMinor -= amount;
					}
					acc.extractedTransactionCount += 1;
					if (entry.primaryCategory === "uncategorized") {
						acc.uncategorizedCount += 1;
					}
					return acc;
				},
				{
					inflowMinor: 0,
					outflowMinor: 0,
					netMinor: 0,
					importedStatementCount: importDocumentRows.filter((row) =>
						row.statement_period_end?.startsWith(String(selectedYear)),
					).length,
					extractedTransactionCount: 0,
					uncategorizedCount: 0,
				},
			);

			const evidenceByCandidate = new Map<
				string,
				Array<{
					id: string;
					messageId: string;
					accountLabel: string;
					subject: string | null;
					receivedAt: string | null;
					transactionIndex: number | null;
					documentIndex: number | null;
				}>
			>();
			for (const row of evidenceRows) {
				const candidateKey = row.event_candidate_id
					? `event:${row.event_candidate_id}`
					: row.document_candidate_id
						? `document:${row.document_candidate_id}`
						: null;
				if (!candidateKey) {
					continue;
				}
				const current = evidenceByCandidate.get(candidateKey) ?? [];
				current.push({
					id: row.id,
					messageId: row.message_id,
					accountLabel: row.account_label,
					subject: row.subject,
					receivedAt: row.received_at,
					transactionIndex: row.transaction_index,
					documentIndex: row.document_index,
				});
				evidenceByCandidate.set(candidateKey, current);
			}

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
				},
				registry,
				coverage,
				summary,
				rollups: refreshedRollupRows
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
					})),
				subcategoryRollups: refreshedSubcategoryRows
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
					})),
				ledgerPreview: filteredLedger.slice(0, 100),
				importedDocuments: importDocumentRows
					.filter(
						(row) =>
							row.statement_period_end?.startsWith(String(selectedYear)) ??
							true,
					)
					.slice(0, 50)
					.map((row) => ({
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
				registrySuggestions: suggestionRows.map((row) => ({
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
				eventCandidates: eventRows.map((row) => ({
					id: row.id,
					canonicalKey: row.canonical_key,
					status: row.status,
					eventKind: row.event_kind,
					direction: row.direction,
					amountValue: row.amount_value,
					currency: row.currency,
					occurredAt: row.occurred_at,
					merchantOrCounterparty: row.merchant_or_counterparty,
					ownerIdentityId: row.owner_identity_id,
					financialAccountId: row.financial_account_id,
					institutionId: row.institution_id,
					categoryHint: row.category_hint,
					taxRelevanceHint: row.tax_relevance_hint,
					evidenceCount: row.evidence_count,
					firstMessageReceivedAt: row.first_message_received_at,
					lastMessageReceivedAt: row.last_message_received_at,
					updatedAt: row.updated_at,
					evidence: evidenceByCandidate.get(`event:${row.id}`) ?? [],
				})),
				documentCandidates: documentRows.map((row) => ({
					id: row.id,
					canonicalKey: row.canonical_key,
					status: row.status,
					documentType: row.document_type,
					issuer: row.issuer,
					externalId: row.external_id,
					statementPeriodStart: row.statement_period_start,
					statementPeriodEnd: row.statement_period_end,
					dueAt: row.due_at,
					taxYear: row.tax_year,
					ownerIdentityId: row.owner_identity_id,
					financialAccountId: row.financial_account_id,
					institutionId: row.institution_id,
					evidenceCount: row.evidence_count,
					firstMessageReceivedAt: row.first_message_received_at,
					lastMessageReceivedAt: row.last_message_received_at,
					updatedAt: row.updated_at,
					evidence: evidenceByCandidate.get(`document:${row.id}`) ?? [],
				})),
			};
		},
		summarize: (result) => ({
			year: result.year,
			event_candidates: result.eventCandidates.length,
			document_candidates: result.documentCandidates.length,
			finance_heads: result.coverage.totalHeads,
			rollups: result.rollups.length,
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
				.innerJoin("accounts", "accounts.id", "messages.account_id")
				.select([
					"messages.id",
					"messages.account_id",
					"accounts.label as account_label",
					"messages.sender_address",
					"messages.subject",
					"messages.received_at",
					"messages.body_text_normalized",
				])
				.where("messages.id", "=", input.messageId)
				.executeTakeFirstOrThrow();
			trace.add({
				account_id: message.account_id,
			});

			const attachments = await db
				.selectFrom("attachments")
				.select(["filename", "mime_type"])
				.where("message_id", "=", input.messageId)
				.execute();

			const [
				{ ensureModerationForMessage, topModerationScores },
				classifyModule,
				overseer,
			] = await Promise.all([
				import("#/lib/moderation"),
				import("#/lib/classify"),
				import("#/lib/overseer"),
			]);

			const moderation = await ensureModerationForMessage({
				jobId: null,
				messageId: message.id,
				sender: message.sender_address ?? "(unknown)",
				subject: message.subject ?? "(no subject)",
				bodyText: message.body_text_normalized,
			});

			const context = await overseer.loadLatestOverseerContext(
				message.account_id,
			);

			const classification = await classifyModule.classifyMessageNow({
				jobId: null,
				messageId: message.id,
				accountLabel: message.account_label,
				sender: message.sender_address ?? "(unknown)",
				subject: message.subject ?? "(no subject)",
				receivedAt: message.received_at ?? "(unknown)",
				bodyText: message.body_text_normalized,
				attachmentsSummary: classifyModule.buildAttachmentSummary(attachments),
				moderationFlag: moderation.nsfwFlag,
				moderationScores: topModerationScores(moderation.scores),
				promptPreamble: context.promptPreamble,
				allowedTags: classifyModule.mergeAllowedTags(context.promotedTags),
			});

			if (classification.label.finance.relevant) {
				await queueFinanceBacklogJob(message.account_id);
			} else {
				await queueFinanceKnowledgeJob();
			}

			return { status: "classified" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function loadAccountsData() {
	return runLoggedAction({
		operation: "loadAccountsData",
		kind: "loader",
		run: async () => {
			const { getDb } = await bootServer();
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
				accounts: accounts.map((account) => ({
					...account,
					message_count: messageCountsByAccount.get(account.id) ?? 0,
					tombstone_count: tombstoneCountsByAccount.get(account.id) ?? 0,
				})),
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
			const [{ isOAuthConfigured, missingOAuthVars }, { GOOGLE_OAUTH }] =
				await Promise.all([
					import("#/lib/google-oauth"),
					import("#/lib/config"),
				]);
			return {
				oauthReady: isOAuthConfigured(),
				missingVars: missingOAuthVars(),
				redirectUrl: GOOGLE_OAUTH.redirectUrl,
			};
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
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const [
				account,
				syncState,
				recentJobs,
				msgCount,
				tombCount,
				financeCoverage,
			] = await Promise.all([
				db
					.selectFrom("accounts")
					.selectAll()
					.where("id", "=", input.accountId)
					.executeTakeFirstOrThrow(),
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
			]);

			return {
				account,
				financeCoverage,
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

export async function beginGoogleConnectCommand(input: { label: string }) {
	return runLoggedAction({
		operation: "beginGoogleConnectCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			const { buildAuthUrl } = await import("#/lib/google-oauth");
			return buildAuthUrl(input.label);
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

			const existingAccount = await db
				.selectFrom("accounts")
				.select(["id", "selected_mailbox"])
				.where("email_address", "=", normalizedEmail)
				.executeTakeFirst();
			const selectedMailbox =
				existingAccount?.selected_mailbox?.trim() || "[Gmail]/All Mail";
			await db
				.insertInto("accounts")
				.values({
					id: existingAccount?.id ?? crypto.randomUUID(),
					label: oauthState.label,
					email_address: normalizedEmail,
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
			const accountId = account.id;
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
			const artifact = financeSourceImportSchema.parse(input.artifact);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "import_finance_artifact",
				scopeType: "system",
				scopeId: artifact.sourceFile.sha256,
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
