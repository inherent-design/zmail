import { randomUUID } from "node:crypto";

import {
	APP_CONFIG,
	nowIso,
	REVIEW_CLASSIFIER_PROMPT_VERSION,
} from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import { piJson } from "#/lib/pi";
import { readPromptIdentity } from "#/lib/prompt-identity";
import { publishActionEvent } from "#/lib/runtime-events";
import {
	type ReviewClassifierV1,
	reviewClassifierJsonSchema,
	reviewClassifierSchema,
} from "#/lib/schemas";

interface ReviewClassifierInputPackage {
	rootReviews: Array<{
		targetKind: "root_review";
		targetId: string;
		messageId: string;
		accountId: string;
		status: string;
		createdAt: string;
		senderAddress: string | null;
		subject: string | null;
		parseStatus: string;
		sourceLabel: unknown;
		currentLabel: unknown;
	}>;
	financeLedgerRows: Array<{
		targetKind: "finance_ledger_entry";
		targetId: string;
		messageId: string | null;
		accountId: string | null;
		status: string;
		occurredAt: string | null;
		description: string | null;
		counterparty: string | null;
		direction: string;
		amountValue: string | null;
		currency: string | null;
		book: string;
		accountMappingKey: string | null;
		fieldConfidence: unknown;
		ledgerMetadata: unknown;
		financeHead: unknown;
	}>;
	mappingCoverage: {
		mappingCount: number;
		missingMappingRows: number;
		reviewRows: number;
		blockedRows: number;
	};
	recentReviewExamples: Array<{
		reviewId: string;
		messageId: string;
		accountId: string;
		reviewerNote: string | null;
		decision: "accepted" | "overridden";
	}>;
	latestOverseerContext: Array<{
		accountId: string;
		promptPreamble: string | null;
		profile: unknown;
	}>;
}

function uniqueStrings(values: Array<string | null | undefined>) {
	return Array.from(
		new Set(
			values
				.map((value) => value?.trim() ?? "")
				.filter((value) => value.length > 0),
		),
	).sort();
}

async function loadReviewClassifierInput(input?: {
	accountId?: string;
	limit?: number;
}): Promise<ReviewClassifierInputPackage> {
	const limit = input?.limit ?? 80;
	const db = getDb();
	let rootQuery = db
		.selectFrom("reviews")
		.innerJoin("messages", "messages.id", "reviews.message_id")
		.innerJoin(
			"classification_results",
			"classification_results.id",
			"reviews.source_classification_result_id",
		)
		.leftJoin("message_labels", "message_labels.message_id", "messages.id")
		.select([
			"reviews.id as review_id",
			"reviews.status",
			"reviews.created_at",
			"messages.id as message_id",
			"messages.account_id",
			"messages.sender_address",
			"messages.subject",
			"messages.parse_status",
			"classification_results.result_json as source_result_json",
			"message_labels.label_json as current_label_json",
		])
		.where("reviews.status", "in", ["open", "resolved"]);
	if (input?.accountId) {
		rootQuery = rootQuery.where("messages.account_id", "=", input.accountId);
	}
	const rootRows = await rootQuery
		.orderBy("reviews.status", "asc")
		.orderBy("reviews.created_at", "desc")
		.limit(limit)
		.execute();

	let ledgerQuery = db
		.selectFrom("finance_ledger_entries")
		.leftJoin(
			"finance_ledger_entry_sources",
			"finance_ledger_entry_sources.ledger_entry_id",
			"finance_ledger_entries.id",
		)
		.leftJoin(
			"messages",
			"messages.id",
			"finance_ledger_entry_sources.message_id",
		)
		.leftJoin("message_secondary_heads", (join) =>
			join
				.onRef(
					"message_secondary_heads.message_id",
					"=",
					"finance_ledger_entry_sources.message_id",
				)
				.on("message_secondary_heads.classifier_key", "=", "finance_intel"),
		)
		.leftJoin(
			"message_secondary_results",
			"message_secondary_results.id",
			"message_secondary_heads.secondary_result_id",
		)
		.select([
			"finance_ledger_entries.id",
			"finance_ledger_entries.status",
			"finance_ledger_entries.occurred_at",
			"finance_ledger_entries.description",
			"finance_ledger_entries.counterparty",
			"finance_ledger_entries.direction",
			"finance_ledger_entries.amount_value",
			"finance_ledger_entries.currency",
			"finance_ledger_entries.book",
			"finance_ledger_entries.account_mapping_key",
			"finance_ledger_entries.field_confidence_json",
			"finance_ledger_entries.ledger_metadata_json",
			"finance_ledger_entry_sources.message_id",
			"messages.account_id",
			"message_secondary_results.result_json as finance_result_json",
		])
		.where("finance_ledger_entries.status", "in", ["review", "blocked"]);
	if (input?.accountId) {
		ledgerQuery = ledgerQuery.where(
			"messages.account_id",
			"=",
			input.accountId,
		);
	}
	const ledgerRows = await ledgerQuery
		.orderBy("finance_ledger_entries.updated_at", "desc")
		.limit(limit)
		.execute();

	const [mappingCount, missingMappings, recentResolvedRows] = await Promise.all(
		[
			db
				.selectFrom("finance_account_mappings")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("finance_ledger_entries")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.where("status", "in", ["review", "blocked"])
				.where("account_mapping_key", "is", null)
				.executeTakeFirstOrThrow(),
			db
				.selectFrom("reviews")
				.innerJoin("messages", "messages.id", "reviews.message_id")
				.select([
					"reviews.id",
					"reviews.message_id",
					"messages.account_id",
					"reviews.reviewer_note",
					"reviews.override_label_json",
				])
				.where("reviews.status", "=", "resolved")
				.orderBy("reviews.resolved_at", "desc")
				.limit(20)
				.execute(),
		],
	);

	const accountIds = uniqueStrings([
		...rootRows.map((row) => row.account_id),
		...ledgerRows.map((row) => row.account_id),
	]);
	const overseerRows =
		accountIds.length === 0
			? []
			: await db
					.selectFrom("overseer_profiles")
					.select(["account_id", "prompt_preamble", "profile_json"])
					.where("account_id", "in", accountIds)
					.orderBy("created_at", "desc")
					.execute();
	const seenOverseerAccounts = new Set<string>();
	const latestOverseerContext = overseerRows.flatMap((row) => {
		if (seenOverseerAccounts.has(row.account_id)) {
			return [];
		}
		seenOverseerAccounts.add(row.account_id);
		return [
			{
				accountId: row.account_id,
				promptPreamble: row.prompt_preamble,
				profile: safeJsonParse(row.profile_json, null),
			},
		];
	});

	return {
		rootReviews: rootRows.map((row) => ({
			targetKind: "root_review",
			targetId: row.review_id,
			messageId: row.message_id,
			accountId: row.account_id,
			status: row.status,
			createdAt: row.created_at,
			senderAddress: row.sender_address,
			subject: row.subject,
			parseStatus: row.parse_status,
			sourceLabel: safeJsonParse(row.source_result_json, null),
			currentLabel: safeJsonParse(row.current_label_json, null),
		})),
		financeLedgerRows: ledgerRows.map((row) => ({
			targetKind: "finance_ledger_entry",
			targetId: row.id,
			messageId: row.message_id,
			accountId: row.account_id,
			status: row.status,
			occurredAt: row.occurred_at,
			description: row.description,
			counterparty: row.counterparty,
			direction: row.direction,
			amountValue: row.amount_value,
			currency: row.currency,
			book: row.book,
			accountMappingKey: row.account_mapping_key,
			fieldConfidence: safeJsonParse(row.field_confidence_json, {}),
			ledgerMetadata: safeJsonParse(row.ledger_metadata_json, {}),
			financeHead: safeJsonParse(row.finance_result_json, null),
		})),
		mappingCoverage: {
			mappingCount: Number(mappingCount.count),
			missingMappingRows: Number(missingMappings.count),
			reviewRows: ledgerRows.filter((row) => row.status === "review").length,
			blockedRows: ledgerRows.filter((row) => row.status === "blocked").length,
		},
		recentReviewExamples: recentResolvedRows.map((row) => ({
			reviewId: row.id,
			messageId: row.message_id,
			accountId: row.account_id,
			reviewerNote: row.reviewer_note,
			decision: row.override_label_json ? "overridden" : "accepted",
		})),
		latestOverseerContext,
	};
}

function emptyResult(): ReviewClassifierV1 {
	return {
		schemaVersion: "review-classifier.v1",
		summary: "No review classifier targets were available.",
		findings: [],
		targetedReclassification: [],
		mappingSuggestionRefs: [],
		overseerSignals: [],
	};
}

function filterValidFindings(
	result: ReviewClassifierV1,
	inputPackage: ReviewClassifierInputPackage,
): ReviewClassifierV1 {
	const validTargets = new Set([
		...inputPackage.rootReviews.map((row) => `root_review:${row.targetId}`),
		...inputPackage.financeLedgerRows.map(
			(row) => `finance_ledger_entry:${row.targetId}`,
		),
	]);
	const validMessageIds = new Set([
		...inputPackage.rootReviews.map((row) => row.messageId),
		...inputPackage.financeLedgerRows.flatMap((row) =>
			row.messageId ? [row.messageId] : [],
		),
	]);
	return {
		...result,
		findings: result.findings.filter((finding) =>
			validTargets.has(`${finding.targetKind}:${finding.targetId}`),
		),
		targetedReclassification: result.targetedReclassification
			.map((entry) => ({
				...entry,
				messageIds: entry.messageIds.filter((messageId) =>
					validMessageIds.has(messageId),
				),
			}))
			.filter((entry) => entry.messageIds.length > 0),
	};
}

async function persistReviewClassifierResult(input: {
	jobId: string | null;
	model: string;
	promptSha256: string;
	inputPackage: ReviewClassifierInputPackage;
	result: ReviewClassifierV1;
	rawResponse: unknown;
	usage: unknown;
}) {
	const db = getDb();
	const resultId = randomUUID();
	const createdAt = nowIso();
	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("review_classification_results")
			.values({
				id: resultId,
				job_id: input.jobId,
				schema_version: input.result.schemaVersion,
				model: input.model,
				prompt_version: REVIEW_CLASSIFIER_PROMPT_VERSION,
				prompt_sha256: input.promptSha256,
				source: "model",
				input_summary_json: jsonText({
					rootReviews: input.inputPackage.rootReviews.length,
					financeLedgerRows: input.inputPackage.financeLedgerRows.length,
					mappingCoverage: input.inputPackage.mappingCoverage,
				}),
				result_json: jsonText(input.result),
				raw_response_json: jsonText(input.rawResponse),
				usage_json: input.usage ? jsonText(input.usage) : null,
				created_at: createdAt,
			})
			.execute();

		for (const finding of input.result.findings) {
			await trx
				.insertInto("review_classification_heads")
				.values({
					target_kind: finding.targetKind,
					target_id: finding.targetId,
					result_id: resultId,
					severity: finding.severity,
					action: finding.action,
					status: "open",
					confidence: finding.confidence,
					reason: finding.reason,
					evidence_refs_json: jsonText(finding.evidenceRefs),
					resolution_note: null,
					decided_at: null,
					updated_at: createdAt,
				})
				.onConflict((oc) =>
					oc.columns(["target_kind", "target_id"]).doUpdateSet({
						result_id: resultId,
						severity: finding.severity,
						action: finding.action,
						status: "open",
						confidence: finding.confidence,
						reason: finding.reason,
						evidence_refs_json: jsonText(finding.evidenceRefs),
						resolution_note: null,
						decided_at: null,
						updated_at: createdAt,
					}),
				)
				.execute();
		}
	});
	return resultId;
}

function groupMessageIdsByAccount(
	rows: Array<{ id: string; account_id: string }>,
) {
	const groups = new Map<string, string[]>();
	for (const row of rows) {
		const current = groups.get(row.account_id) ?? [];
		current.push(row.id);
		groups.set(row.account_id, current);
	}
	return groups;
}

export async function dispatchReviewClassifierActions(input: {
	resultId: string;
	result: ReviewClassifierV1;
	inputPackage: ReviewClassifierInputPackage;
}) {
	const rootReviewByTarget = new Map(
		input.inputPackage.rootReviews.map((row) => [row.targetId, row]),
	);
	const ledgerByTarget = new Map(
		input.inputPackage.financeLedgerRows.map((row) => [row.targetId, row]),
	);
	const rootMessageIds = new Set<string>();
	const financeMessageIds = new Set<string>();

	for (const finding of input.result.findings) {
		if (
			finding.action === "enqueue_root_reclassify" &&
			finding.targetKind === "root_review"
		) {
			const review = rootReviewByTarget.get(finding.targetId);
			if (review) {
				rootMessageIds.add(review.messageId);
			}
		}
		if (
			finding.action === "enqueue_finance_reclassify" &&
			finding.targetKind === "finance_ledger_entry"
		) {
			const ledger = ledgerByTarget.get(finding.targetId);
			if (ledger?.messageId) {
				financeMessageIds.add(ledger.messageId);
			}
		}
	}
	for (const entry of input.result.targetedReclassification) {
		for (const messageId of entry.messageIds) {
			if (entry.classifier === "root") {
				rootMessageIds.add(messageId);
			} else {
				financeMessageIds.add(messageId);
			}
		}
	}

	const allMessageIds = [...new Set([...rootMessageIds, ...financeMessageIds])];
	const messageRows =
		allMessageIds.length === 0
			? []
			: await getDb()
					.selectFrom("messages")
					.select(["id", "account_id"])
					.where("id", "in", allMessageIds)
					.execute();
	const byAccount = groupMessageIdsByAccount(messageRows);

	for (const [accountId, messageIds] of byAccount) {
		const rootTargets = messageIds.filter((messageId) =>
			rootMessageIds.has(messageId),
		);
		if (rootTargets.length > 0) {
			await queueJobIdempotent({
				kind: "classify_root_messages",
				scopeType: "account",
				scopeId: accountId,
				model: APP_CONFIG.classifierModel,
				promptVersion: "classify-email-v3",
				meta: {
					targetMessageIds: rootTargets,
					reviewClassificationResultId: input.resultId,
				},
			});
		}
		const financeTargets = messageIds.filter((messageId) =>
			financeMessageIds.has(messageId),
		);
		if (financeTargets.length > 0) {
			await queueJobIdempotent({
				kind: "classify_finance_messages",
				scopeType: "account",
				scopeId: accountId,
				model: APP_CONFIG.classifierModel,
				promptVersion: "finance-intel-v3",
				meta: {
					targetMessageIds: financeTargets,
					reviewClassificationResultId: input.resultId,
				},
			});
		}
	}

	const mappingFindings = input.result.findings.filter(
		(finding) => finding.action === "mapping_needed",
	);
	if (mappingFindings.length > 0) {
		const now = nowIso();
		await getDb()
			.insertInto("registry_suggestions")
			.values(
				mappingFindings.map((finding) => ({
					id: randomUUID(),
					entity_kind: "finance_account_mapping",
					canonical_key: `review-classifier:${finding.targetKind}:${finding.targetId}`,
					suggestion_json: jsonText({
						reviewClassificationResultId: input.resultId,
						targetKind: finding.targetKind,
						targetId: finding.targetId,
						reason: finding.reason,
						evidenceRefs: finding.evidenceRefs,
					}),
					source_kind: "review_classifier",
					source_ref_id: input.resultId,
					confidence: finding.confidence,
					status: "pending",
					applied_registry_id: null,
					created_at: now,
					updated_at: now,
				})),
			)
			.execute();
	}

	const overseerAccountIds = uniqueStrings([
		...input.inputPackage.rootReviews.map((row) => row.accountId),
		...input.inputPackage.financeLedgerRows.map((row) => row.accountId),
	]);
	if (
		input.result.overseerSignals.length > 0 ||
		input.result.findings.some(
			(finding) => finding.action === "overseer_signal",
		)
	) {
		for (const accountId of overseerAccountIds) {
			await queueJobIdempotent({
				kind: "rebuild_overseer",
				scopeType: "account",
				scopeId: accountId,
				model: APP_CONFIG.fallbackModel,
				promptVersion: "overseer-profile-v1",
				meta: { reviewClassificationResultId: input.resultId },
			});
		}
	}

	await publishActionEvent({
		topic: "reviews",
		eventType: "review_classifier.completed",
		entityKind: "review_classification_result",
		entityId: input.resultId,
		payload: {
			resultId: input.resultId,
			findings: input.result.findings.length,
			targetedRootMessages: rootMessageIds.size,
			targetedFinanceMessages: financeMessageIds.size,
			changeHints: {
				islands: ["review.findings", "finance.review", "finance.lanes"],
			},
		},
	});
	await publishActionEvent({
		topic: "finance",
		eventType: "review_classifier.completed",
		entityKind: "review_classification_result",
		entityId: input.resultId,
		payload: {
			resultId: input.resultId,
			findings: input.result.findings.length,
			changeHints: {
				islands: ["finance.review", "finance.lanes"],
			},
		},
	});
}

export async function runReviewClassifier(input?: {
	jobId?: string | null;
	accountId?: string;
	limit?: number;
}) {
	const inputPackage = await loadReviewClassifierInput(input);
	const hasTargets =
		inputPackage.rootReviews.length > 0 ||
		inputPackage.financeLedgerRows.length > 0;
	const prompt = readPromptIdentity(`${REVIEW_CLASSIFIER_PROMPT_VERSION}.md`);
	const model = APP_CONFIG.classifierModel;
	const result = hasTargets
		? await piJson({
				schema: reviewClassifierSchema,
				modelId: model,
				systemPrompt: prompt.text,
				userPrompt: `${JSON.stringify(inputPackage, null, 2)}

JSON contract:
${JSON.stringify(reviewClassifierJsonSchema, null, 2)}`,
			})
		: {
				parsed: emptyResult(),
				raw: { skipped: "no_targets" },
				usage: null,
				backend: "system" as const,
			};
	const rawResponse =
		"rawText" in result
			? { backend: result.backend, rawText: result.rawText }
			: result.raw;
	const parsed = filterValidFindings(
		reviewClassifierSchema.parse(result.parsed),
		inputPackage,
	);
	const resultId = await persistReviewClassifierResult({
		jobId: input?.jobId ?? null,
		model: "modelId" in result ? result.modelId : model,
		promptSha256: prompt.sha256,
		inputPackage,
		result: parsed,
		rawResponse,
		usage: result.usage,
	});
	const { publishActionEvent } = await import("#/lib/runtime-events");
	await publishActionEvent({
		topic: "reviews",
		eventType: "review_classifier.completed",
		entityKind: "review_classification_result",
		entityId: resultId,
		payload: {
			resultId,
			findings: parsed.findings.length,
			changeHints: {
				islands: ["review.stats", "review.queue", "review.actions"],
				nodes: parsed.findings.map((finding) => ({
					type: "node",
					islandId: "review.queue",
					nodeId: "review.finding.item",
					key: `${finding.targetKind}:${finding.targetId}`,
				})),
			},
		},
	});
	await publishActionEvent({
		topic: "finance",
		eventType: "review_classifier.completed",
		entityKind: "review_classification_result",
		entityId: resultId,
		payload: {
			resultId,
			findings: parsed.findings.length,
			changeHints: {
				islands: ["finance.review", "finance.lanes"],
				nodes: parsed.findings.map((finding) => ({
					type: "node",
					islandId: "finance.review",
					nodeId: "finance.review.finding",
					key: `${finding.targetKind}:${finding.targetId}`,
				})),
			},
		},
	});
	return {
		resultId,
		result: parsed,
		inputCounts: {
			rootReviews: inputPackage.rootReviews.length,
			financeLedgerRows: inputPackage.financeLedgerRows.length,
		},
	};
}
