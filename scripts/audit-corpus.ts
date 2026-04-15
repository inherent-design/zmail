import {
	ensureStorageDirs,
	MODERATION_PROMPT_VERSION,
	nowIso,
} from "#/lib/config";
import { getDb, getSqlite, runMigrations, safeJsonParse } from "#/lib/db";
import type { LogTrace } from "#/lib/log";
import { getStoredModerationPromptVersion } from "#/lib/moderation";
import { runCli } from "#/scripts/_shared";

function count(sql: string, ...params: unknown[]) {
	const sqlite = getSqlite();
	const row = sqlite.prepare(sql).get(...params) as { count: number };
	return Number(row.count);
}

export async function main(_trace?: LogTrace) {
	ensureStorageDirs();
	runMigrations();

	const db = getDb();

	const [
		labelRows,
		parseReasons,
		moderationRows,
		conversationRows,
		conversationRollups,
		financeHeadStatusRows,
		financeHeadVersionRows,
		jobRows,
		registryState,
	] = await Promise.all([
		db.selectFrom("message_labels").select(["label_json"]).execute(),
		db
			.selectFrom("messages")
			.select([
				"parse_error_reason",
				(eb) => eb.fn.countAll<number>().as("count"),
			])
			.where("parse_status", "=", "error")
			.groupBy("parse_error_reason")
			.execute(),
		db.selectFrom("moderation_results").select(["raw_response_json"]).execute(),
		db
			.selectFrom("messages")
			.leftJoin("message_sources", "message_sources.message_id", "messages.id")
			.select([
				"messages.id",
				"messages.thread_key",
				"messages.conversation_id",
				"messages.received_at",
				"message_sources.remote_thread_id",
			])
			.execute(),
		db.selectFrom("conversations").selectAll().execute(),
		db
			.selectFrom("message_secondary_heads")
			.select(["status", (eb) => eb.fn.countAll<number>().as("count")])
			.where("classifier_key", "=", "finance_intel")
			.groupBy("status")
			.execute(),
		db
			.selectFrom("message_secondary_heads")
			.innerJoin(
				"message_secondary_results",
				"message_secondary_results.id",
				"message_secondary_heads.secondary_result_id",
			)
			.select([
				"message_secondary_results.schema_version",
				(eb) => eb.fn.countAll<number>().as("count"),
			])
			.where("message_secondary_heads.classifier_key", "=", "finance_intel")
			.groupBy("message_secondary_results.schema_version")
			.execute(),
		db
			.selectFrom("jobs")
			.select(["kind", "status", (eb) => eb.fn.countAll<number>().as("count")])
			.where("status", "in", ["queued", "running"])
			.groupBy(["kind", "status"])
			.execute(),
		db
			.selectFrom("registry_import_state")
			.selectAll()
			.where("key", "=", "operator_registry")
			.executeTakeFirst(),
	]);

	const rootFinanceRelevantCount = labelRows.reduce((countValue, row) => {
		const label = safeJsonParse<{ finance?: { relevant?: boolean } } | null>(
			row.label_json,
			null,
		);
		return countValue + Number(Boolean(label?.finance?.relevant));
	}, 0);

	let rowsWithCurrentPromptVersion = 0;
	let rowsWithStalePromptVersion = 0;
	let rowsMissingPromptVersion = 0;
	for (const row of moderationRows) {
		const promptVersion = getStoredModerationPromptVersion(row.raw_response_json);
		if (!promptVersion) {
			rowsMissingPromptVersion += 1;
		} else if (promptVersion === MODERATION_PROMPT_VERSION) {
			rowsWithCurrentPromptVersion += 1;
		} else {
			rowsWithStalePromptVersion += 1;
		}
	}

	const remoteThreadToThreadKeys = new Map<string, Set<string>>();
	const threadKeyToRemoteThreads = new Map<string, Set<string>>();
	const conversationActual = new Map<
		string,
		{ count: number; first: string | null; last: string | null }
	>();

	for (const row of conversationRows) {
		if (row.remote_thread_id) {
			const threadKeys =
				remoteThreadToThreadKeys.get(row.remote_thread_id) ?? new Set();
			threadKeys.add(row.thread_key);
			remoteThreadToThreadKeys.set(row.remote_thread_id, threadKeys);
		}

		const remoteThreads =
			threadKeyToRemoteThreads.get(row.thread_key) ?? new Set();
		if (row.remote_thread_id) {
			remoteThreads.add(row.remote_thread_id);
		}
		threadKeyToRemoteThreads.set(row.thread_key, remoteThreads);

		if (row.conversation_id) {
			const current = conversationActual.get(row.conversation_id) ?? {
				count: 0,
				first: null,
				last: null,
			};
			current.count += 1;
			if (
				!current.first ||
				(row.received_at && row.received_at < current.first)
			) {
				current.first = row.received_at;
			}
			if (
				!current.last ||
				(row.received_at && row.received_at > current.last)
			) {
				current.last = row.received_at;
			}
			conversationActual.set(row.conversation_id, current);
		}
	}

	let conversationRollupMismatchCount = 0;
	for (const row of conversationRollups) {
		const actual = conversationActual.get(row.id);
		if (!actual) {
			conversationRollupMismatchCount += 1;
			continue;
		}
		const rollupMatches = [
			row.message_count === actual.count,
			(row.first_message_received_at ?? null) === actual.first,
			(row.last_message_received_at ?? null) === actual.last,
		].every(Boolean);
		if (!rollupMatches) {
			conversationRollupMismatchCount += 1;
		}
	}

	const financeHeadStatusCounts = {
		ready: 0,
		review: 0,
		stale: 0,
		blocked_parse_error: 0,
	};
	for (const row of financeHeadStatusRows) {
		if (row.status in financeHeadStatusCounts) {
			financeHeadStatusCounts[
				row.status as keyof typeof financeHeadStatusCounts
			] = Number(row.count);
		}
	}

	const financeHeadVersionCounts = {
		"finance-intel.v1": 0,
		"finance-intel.v2": 0,
	};
	for (const row of financeHeadVersionRows) {
		if (row.schema_version in financeHeadVersionCounts) {
			financeHeadVersionCounts[
				row.schema_version as keyof typeof financeHeadVersionCounts
			] = Number(row.count);
		}
	}

	const openJobCounts = jobRows.reduce<Record<string, Record<string, number>>>(
		(acc, row) => {
			const current = acc[row.kind] ?? {};
			current[row.status] = Number(row.count);
			acc[row.kind] = current;
			return acc;
		},
		{},
	);

	const report = {
		generatedAt: nowIso(),
		sourceInvariants: {
			messages: count("SELECT COUNT(*) AS count FROM messages"),
			messageSources: count("SELECT COUNT(*) AS count FROM message_sources"),
			messagesWithoutSource: count(
				`
					SELECT COUNT(*) AS count
					FROM messages
					LEFT JOIN message_sources ON message_sources.message_id = messages.id
					WHERE message_sources.message_id IS NULL
				`,
			),
			sourcesWithoutMessage: count(
				`
					SELECT COUNT(*) AS count
					FROM message_sources
					LEFT JOIN messages ON messages.id = message_sources.message_id
					WHERE messages.id IS NULL
				`,
			),
			sourcesMissingRemoteMessageId: count(
				`
					SELECT COUNT(*) AS count
					FROM message_sources
					WHERE remote_message_id IS NULL OR TRIM(remote_message_id) = ''
				`,
			),
			sourcesMissingRemoteThreadId: count(
				`
					SELECT COUNT(*) AS count
					FROM message_sources
					WHERE remote_thread_id IS NULL OR TRIM(remote_thread_id) = ''
				`,
			),
		},
		rootClassification: {
			staleLabels: count(
				`
					SELECT COUNT(*) AS count
					FROM message_labels
					INNER JOIN messages ON messages.id = message_labels.message_id
					WHERE message_labels.content_sha256 != messages.content_sha256
				`,
			),
			openReviews: count(
				"SELECT COUNT(*) AS count FROM reviews WHERE status = 'open'",
			),
			rootV1CurrentHeads: count(
				`
					SELECT COUNT(*) AS count
					FROM message_labels
					WHERE schema_version = 'message-label.v1'
				`,
			),
			rootV2CurrentHeads: count(
				`
					SELECT COUNT(*) AS count
					FROM message_labels
					WHERE schema_version = 'message-label.v2'
				`,
			),
			staleReviewPointers: count(
				`
					SELECT COUNT(*) AS count
					FROM reviews
					INNER JOIN message_labels ON message_labels.message_id = reviews.message_id
					WHERE reviews.status = 'open'
					  AND reviews.source_classification_result_id != message_labels.classification_result_id
				`,
			),
		},
		badParsedBodies: {
			undefinedSnippet: count(
				`
					SELECT COUNT(*) AS count
					FROM messages
					WHERE snippet = 'undefined'
				`,
			),
			plainTextNotAvailable: count(
				`
					SELECT COUNT(*) AS count
					FROM messages
					WHERE lower(trim(body_text_primary)) IN ('undefined', 'plain text version not available')
				`,
			),
			htmlLiteralPlainText: count(
				`
					SELECT COUNT(*) AS count
					FROM messages
					WHERE body_extraction_strategy = 'plain_text'
					  AND (
							lower(body_text_primary) LIKE '<html%'
							OR lower(body_text_primary) LIKE '<!doctype%'
					  )
				`,
			),
		},
		parseErrors: {
			total: count(
				"SELECT COUNT(*) AS count FROM messages WHERE parse_status = 'error'",
			),
			openReviewLeakage: count(
				`
					SELECT COUNT(*) AS count
					FROM reviews
					INNER JOIN messages ON messages.id = reviews.message_id
					WHERE reviews.status = 'open'
					  AND messages.parse_status = 'error'
				`,
			),
			reasons: parseReasons.map((row) => ({
				reason: row.parse_error_reason ?? "(none)",
				count: Number(row.count),
			})),
		},
		moderation: {
			currentPromptVersion: MODERATION_PROMPT_VERSION,
			rowsWithCurrentPromptVersion,
			rowsWithStalePromptVersion,
			rowsMissingPromptVersion,
		},
		conversations: {
			nullConversationLinks: count(
				"SELECT COUNT(*) AS count FROM messages WHERE conversation_id IS NULL",
			),
			remoteThreadFanoutAcrossThreadKeys: Array.from(
				remoteThreadToThreadKeys.values(),
			).filter((set) => set.size > 1).length,
			threadKeyCollapseAcrossRemoteThreads: Array.from(
				threadKeyToRemoteThreads.values(),
			).filter((set) => set.size > 1).length,
			rollupMismatches: conversationRollupMismatchCount,
		},
		secondaryFinance: {
			rootFinanceRelevantMessages: rootFinanceRelevantCount,
			totalHeads: count(
				`
					SELECT COUNT(*) AS count
					FROM message_secondary_heads
					WHERE classifier_key = 'finance_intel'
				`,
			),
			statuses: financeHeadStatusCounts,
			financeV1Heads: financeHeadVersionCounts["finance-intel.v1"],
			financeV2Heads: financeHeadVersionCounts["finance-intel.v2"],
			eventCandidates: count(
				"SELECT COUNT(*) AS count FROM finance_event_candidates",
			),
			documentCandidates: count(
				"SELECT COUNT(*) AS count FROM finance_document_candidates",
			),
			evidenceRows: count(
				"SELECT COUNT(*) AS count FROM finance_event_evidence",
			),
		},
		categoryAssignments: {
			missingCategoryAssignmentHeads: count(
				`
					SELECT COUNT(*) AS count
					FROM message_labels
					LEFT JOIN message_category_assignment_heads
						ON message_category_assignment_heads.message_id = message_labels.message_id
					WHERE message_category_assignment_heads.message_id IS NULL
				`,
			),
		},
		jobs: openJobCounts,
		registry: registryState
			? {
					importedAt: registryState.imported_at,
					sourceDir: registryState.source_dir,
					sha256: registryState.combined_sha256,
					counts: safeJsonParse(registryState.counts_json, {}),
				}
			: {
					importedAt: null,
					sourceDir: "data/operator/registry",
					sha256: null,
					counts: {},
				},
	};

	console.log(JSON.stringify(report, null, 2));
}

runCli(main, import.meta.url, "audit:corpus");
