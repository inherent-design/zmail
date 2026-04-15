import { randomUUID } from "node:crypto";

import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { normalizeFinanceIntel, normalizeMessageLabel } from "#/lib/schemas";

function normalizeKeyPart(value: string | null | undefined) {
	return (value ?? "").trim().toLowerCase();
}

function buildTransactionCanonicalKey(input: {
	messageId: string;
	transactionIndex: number;
	conversationId: string | null;
	transaction: NonNullable<
		ReturnType<typeof normalizeFinanceIntel>
	>["transactionCandidates"][number];
}) {
	const coreKey = [
		normalizeKeyPart(input.transaction.financialAccountRef),
		normalizeKeyPart(input.transaction.institutionRef),
		normalizeKeyPart(input.transaction.merchantOrCounterparty),
		normalizeKeyPart(input.transaction.amount),
		normalizeKeyPart(input.transaction.currency),
		normalizeKeyPart(input.transaction.occurredAt),
		normalizeKeyPart(input.transaction.direction),
	].filter((part) => part.length > 0);

	if (coreKey.length >= 4) {
		return `tx:${coreKey.join("|")}`;
	}

	if (
		input.conversationId &&
		input.transaction.amount &&
		input.transaction.occurredAt
	) {
		return `tx:conversation:${input.conversationId}:${normalizeKeyPart(
			input.transaction.amount,
		)}:${normalizeKeyPart(input.transaction.occurredAt)}`;
	}

	return `tx:message:${input.messageId}:${input.transactionIndex}`;
}

function buildDocumentCanonicalKey(input: {
	messageId: string;
	documentIndex: number;
	document: NonNullable<
		ReturnType<typeof normalizeFinanceIntel>
	>["documentCandidates"][number];
}) {
	const explicitKey = [
		normalizeKeyPart(input.document.documentType),
		normalizeKeyPart(input.document.externalId),
		normalizeKeyPart(input.document.issuer),
		normalizeKeyPart(input.document.statementPeriodStart),
		normalizeKeyPart(input.document.statementPeriodEnd),
		normalizeKeyPart(input.document.dueAt),
		String(input.document.taxYear ?? ""),
	].filter((part) => part.length > 0);

	if (explicitKey.length >= 3) {
		return `doc:${explicitKey.join("|")}`;
	}

	return `doc:message:${input.messageId}:${input.documentIndex}`;
}

function minNullableIso(
	left: string | null,
	right: string | null,
): string | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return left < right ? left : right;
}

function maxNullableIso(
	left: string | null,
	right: string | null,
): string | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return left > right ? left : right;
}

export async function rebuildFinanceKnowledge() {
	const db = getDb();
	const rows = await db
		.selectFrom("message_secondary_heads")
		.innerJoin(
			"message_secondary_results",
			"message_secondary_results.id",
			"message_secondary_heads.secondary_result_id",
		)
		.innerJoin("messages", "messages.id", "message_secondary_heads.message_id")
		.innerJoin("message_labels", "message_labels.message_id", "messages.id")
		.select([
			"message_secondary_heads.message_id",
			"message_secondary_heads.status as head_status",
			"message_secondary_results.id as secondary_result_id",
			"message_secondary_results.result_json",
			"messages.account_id",
			"messages.conversation_id",
			"messages.received_at",
			"messages.subject",
			"message_labels.label_json",
		])
		.where("message_secondary_heads.classifier_key", "=", "finance_intel")
		.where("message_secondary_heads.status", "in", ["ready", "review"])
		.orderBy("message_secondary_heads.message_id", "asc")
		.execute();

	const eventCandidates = new Map<
		string,
		{
			id: string;
			status: string;
			event_kind: string;
			direction: string | null;
			amount_value: string | null;
			currency: string | null;
			occurred_at: string | null;
			merchant_or_counterparty: string | null;
			owner_identity_id: string | null;
			financial_account_id: string | null;
			institution_id: string | null;
			category_hint: string | null;
			tax_relevance_hint: string | null;
			evidence_count: number;
			first_message_received_at: string | null;
			last_message_received_at: string | null;
			created_at: string;
			updated_at: string;
		}
	>();
	const documentCandidates = new Map<
		string,
		{
			id: string;
			status: string;
			document_type: string;
			issuer: string | null;
			external_id: string | null;
			statement_period_start: string | null;
			statement_period_end: string | null;
			due_at: string | null;
			tax_year: number | null;
			owner_identity_id: string | null;
			financial_account_id: string | null;
			institution_id: string | null;
			evidence_count: number;
			first_message_received_at: string | null;
			last_message_received_at: string | null;
			created_at: string;
			updated_at: string;
		}
	>();
	const evidenceRows: Array<{
		id: string;
		event_candidate_id: string | null;
		document_candidate_id: string | null;
		message_id: string;
		secondary_result_id: string;
		transaction_index: number | null;
		document_index: number | null;
		evidence_json: string;
		created_at: string;
	}> = [];
	const now = new Date().toISOString();

	for (const row of rows) {
		const financeIntel = normalizeFinanceIntel(
			safeJsonParse(row.result_json, null),
		);
		const rootLabel = normalizeMessageLabel(
			safeJsonParse(row.label_json, null),
		);
		if (!financeIntel || !rootLabel?.finance.relevant) {
			continue;
		}

		for (const [
			transactionIndex,
			transaction,
		] of financeIntel.transactionCandidates.entries()) {
			const canonicalKey = buildTransactionCanonicalKey({
				messageId: row.message_id,
				transactionIndex,
				conversationId: row.conversation_id,
				transaction,
			});
			let candidate = eventCandidates.get(canonicalKey);
			if (!candidate) {
				candidate = {
					id: randomUUID(),
					status:
						row.head_status === "review" ||
						financeIntel.actionability === "manual_review"
							? "review"
							: "candidate",
					event_kind: transaction.kind,
					direction: transaction.direction,
					amount_value: transaction.amount,
					currency: transaction.currency,
					occurred_at: transaction.occurredAt,
					merchant_or_counterparty: transaction.merchantOrCounterparty,
					owner_identity_id: transaction.ownerIdentityRef,
					financial_account_id: transaction.financialAccountRef,
					institution_id: transaction.institutionRef,
					category_hint:
						transaction.categorySecondary ?? transaction.categoryPrimary,
					tax_relevance_hint: transaction.taxRelevanceHint,
					evidence_count: 0,
					first_message_received_at: row.received_at,
					last_message_received_at: row.received_at,
					created_at: now,
					updated_at: now,
				};
				eventCandidates.set(canonicalKey, candidate);
			}

			candidate.evidence_count += 1;
			candidate.first_message_received_at = minNullableIso(
				candidate.first_message_received_at,
				row.received_at,
			);
			candidate.last_message_received_at = maxNullableIso(
				candidate.last_message_received_at,
				row.received_at,
			);
			if (row.head_status === "review") {
				candidate.status = "review";
			}

			evidenceRows.push({
				id: randomUUID(),
				event_candidate_id: candidate.id,
				document_candidate_id: null,
				message_id: row.message_id,
				secondary_result_id: row.secondary_result_id,
				transaction_index: transactionIndex,
				document_index: null,
				evidence_json: jsonText({
					type: "transaction",
					evidence: transaction.evidence,
					subject: row.subject,
					transaction,
				}),
				created_at: now,
			});
		}

		for (const [
			documentIndex,
			document,
		] of financeIntel.documentCandidates.entries()) {
			const canonicalKey = buildDocumentCanonicalKey({
				messageId: row.message_id,
				documentIndex,
				document,
			});
			let candidate = documentCandidates.get(canonicalKey);
			if (!candidate) {
				candidate = {
					id: randomUUID(),
					status:
						row.head_status === "review" ||
						financeIntel.actionability === "manual_review"
							? "review"
							: "candidate",
					document_type: document.documentType,
					issuer: document.issuer,
					external_id: document.externalId,
					statement_period_start: document.statementPeriodStart,
					statement_period_end: document.statementPeriodEnd,
					due_at: document.dueAt,
					tax_year: document.taxYear,
					owner_identity_id:
						financeIntel.matchedRegistryRefs.identityIds[0] ?? null,
					financial_account_id:
						financeIntel.matchedRegistryRefs.financialAccountIds[0] ?? null,
					institution_id:
						financeIntel.matchedRegistryRefs.institutionIds[0] ?? null,
					evidence_count: 0,
					first_message_received_at: row.received_at,
					last_message_received_at: row.received_at,
					created_at: now,
					updated_at: now,
				};
				documentCandidates.set(canonicalKey, candidate);
			}

			candidate.evidence_count += 1;
			candidate.first_message_received_at = minNullableIso(
				candidate.first_message_received_at,
				row.received_at,
			);
			candidate.last_message_received_at = maxNullableIso(
				candidate.last_message_received_at,
				row.received_at,
			);
			if (row.head_status === "review") {
				candidate.status = "review";
			}

			evidenceRows.push({
				id: randomUUID(),
				event_candidate_id: null,
				document_candidate_id: candidate.id,
				message_id: row.message_id,
				secondary_result_id: row.secondary_result_id,
				transaction_index: null,
				document_index: documentIndex,
				evidence_json: jsonText({
					type: "document",
					evidence: document.evidence,
					subject: row.subject,
					document,
				}),
				created_at: now,
			});
		}
	}

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("finance_event_evidence").execute();
		await trx.deleteFrom("finance_event_candidates").execute();
		await trx.deleteFrom("finance_document_candidates").execute();

		if (eventCandidates.size > 0) {
			await trx
				.insertInto("finance_event_candidates")
				.values(
					Array.from(eventCandidates.entries()).map(
						([canonicalKey, candidate]) => ({
							canonical_key: canonicalKey,
							...candidate,
						}),
					),
				)
				.execute();
		}

		if (documentCandidates.size > 0) {
			await trx
				.insertInto("finance_document_candidates")
				.values(
					Array.from(documentCandidates.entries()).map(
						([canonicalKey, candidate]) => ({
							canonical_key: canonicalKey,
							...candidate,
						}),
					),
				)
				.execute();
		}

		if (evidenceRows.length > 0) {
			await trx
				.insertInto("finance_event_evidence")
				.values(evidenceRows)
				.execute();
		}
	});

	return {
		documents: documentCandidates.size,
		evidence: evidenceRows.length,
		events: eventCandidates.size,
	};
}
