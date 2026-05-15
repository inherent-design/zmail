import { randomUUID } from "node:crypto";

import { nowIso } from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { parseAmountMinor } from "#/lib/finance-imports";
import {
	dateRecoveryMetadata,
	precisionForLedgerDate,
	resolveLedgerDateForComposite,
} from "#/lib/finance-ledger-dates";
import {
	type FinanceIntelV3,
	normalizeFinanceImportSourceKind,
	parseCurrentFinanceIntel,
	parseCurrentMessageLabel,
} from "#/lib/schemas";

type LedgerStatus = "ready" | "review" | "blocked" | "duplicate";

interface AccountMapping {
	mappingKey: string;
	book: string;
	debitAccount: string | null;
	creditAccount: string | null;
	currency: string | null;
	confidence: number;
	raw: Record<string, unknown>;
}

interface LedgerEntryDraft {
	id: string;
	canonical_key: string;
	status: LedgerStatus;
	source_authority: string;
	occurred_at: string | null;
	occurred_at_precision: string;
	posted_at: string | null;
	posted_at_precision: string;
	cleared_at: string | null;
	cleared_at_precision: string;
	description: string | null;
	counterparty: string | null;
	direction: string;
	amount_value: string | null;
	amount_minor: number | null;
	currency: string | null;
	book: string;
	business_use_percent: number | null;
	debit_account: string | null;
	credit_account: string | null;
	account_mapping_key: string | null;
	field_confidence_json: string;
	ledger_metadata_json: string;
	raw_payload_json: string;
	created_at: string;
	updated_at: string;
}

interface LedgerSourceDraft {
	id: string;
	ledger_entry_id: string | null;
	source_kind: string;
	message_id: string | null;
	secondary_result_id: string | null;
	import_run_id: string | null;
	import_transaction_id: string | null;
	import_document_id: string | null;
	evidence_json: string;
	created_at: string;
}

function normalizeKeyPart(value: string | null | undefined) {
	return (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function normalizedComposite(input: {
	book: string;
	account: string | null;
	date: string | null;
	amount: string | null;
	currency: string | null;
	counterparty: string | null;
}) {
	return [
		input.book,
		input.account ?? "unknown-account",
		(input.date ?? "").slice(0, 10),
		normalizeKeyPart(input.amount),
		(input.currency ?? "").toUpperCase(),
		normalizeKeyPart(input.counterparty),
	].join("|");
}

function canonicalKey(input: {
	source: "email" | "import";
	institution: string | null;
	account: string | null;
	externalTransactionId?: string | null;
	artifactSha256?: string | null;
	statementRowId?: string | null;
	rowIndex?: number | null;
	messageId?: string | null;
	messageEvidenceKey?: string | null;
	composite: string;
}) {
	if (input.externalTransactionId) {
		return `external:${normalizeKeyPart(input.institution)}:${normalizeKeyPart(
			input.account,
		)}:${normalizeKeyPart(input.externalTransactionId)}`;
	}
	if (input.source === "import" && input.artifactSha256) {
		return `import:${input.artifactSha256}:${
			input.statementRowId ?? String(input.rowIndex ?? "unknown-row")
		}`;
	}
	if (input.composite.replace(/\|/g, "").length > 0) {
		return compositeCanonicalKey(input.composite);
	}
	return `email:${input.messageId ?? "unknown"}:${
		input.messageEvidenceKey ?? "unknown"
	}`;
}

function compositeCanonicalKey(composite: string) {
	return `composite:${composite}`;
}

function metadataWithDateRecovery(
	metadata: Record<string, unknown>,
	dateRecovery: Record<string, unknown> | null,
) {
	return dateRecovery ? { ...metadata, dateRecovery } : metadata;
}

function accountFromMapping(
	mappings: Map<string, AccountMapping>,
	mappingKey: string | null,
) {
	return mappingKey ? (mappings.get(mappingKey) ?? null) : null;
}

function isMapped(input: {
	debitAccount: string | null;
	creditAccount: string | null;
	currency: string | null;
}) {
	return Boolean(input.debitAccount && input.creditAccount && input.currency);
}

function statusForDraft(input: {
	sourceConfidence: number;
	ledgerStatus: FinanceIntelV3["ledgerReadiness"]["status"] | null;
	book: string;
	businessUsePercent: number | null;
	amountMinor: number | null;
	beancountDate: string | null;
	counterparty: string | null;
	debitAccount: string | null;
	creditAccount: string | null;
	currency: string | null;
}) {
	if (input.ledgerStatus === "not_ledger") {
		return "blocked" satisfies LedgerStatus;
	}
	if (input.book === "mixed" && input.businessUsePercent === null) {
		return "blocked" satisfies LedgerStatus;
	}
	if (
		input.amountMinor === null ||
		!input.beancountDate ||
		!input.counterparty ||
		!isMapped(input)
	) {
		return "review" satisfies LedgerStatus;
	}
	if (input.sourceConfidence < 0.8) {
		return "review" satisfies LedgerStatus;
	}
	return "ready" satisfies LedgerStatus;
}

function sourcePriority(sourceAuthority: string) {
	if (sourceAuthority === "text" || sourceAuthority === "csv") {
		return 3;
	}
	if (sourceAuthority === "ofx" || sourceAuthority === "pdf") {
		return 2;
	}
	if (sourceAuthority === "email") {
		return 1;
	}
	return 0;
}

function chooseWinner(left: LedgerEntryDraft, right: LedgerEntryDraft) {
	const priority =
		sourcePriority(right.source_authority) -
		sourcePriority(left.source_authority);
	if (priority > 0) {
		return right;
	}
	if (priority < 0) {
		return left;
	}
	return right.status === "ready" && left.status !== "ready" ? right : left;
}

function addOrMerge(
	entries: Map<string, LedgerEntryDraft>,
	sources: LedgerSourceDraft[],
	entry: LedgerEntryDraft,
	source: Omit<LedgerSourceDraft, "ledger_entry_id">,
) {
	const existing = entries.get(entry.canonical_key);
	if (!existing) {
		entries.set(entry.canonical_key, entry);
		sources.push({ ...source, ledger_entry_id: entry.id });
		return;
	}

	const winner = chooseWinner(existing, entry);
	const loser = winner === existing ? entry : existing;
	entries.set(entry.canonical_key, winner);
	for (const existingSource of sources) {
		if (existingSource.ledger_entry_id === loser.id) {
			existingSource.ledger_entry_id = winner.id;
		}
	}
	sources.push({
		...source,
		ledger_entry_id: winner.id,
		evidence_json: jsonText({
			...safeJsonParse(source.evidence_json, {}),
			duplicateSuppressed: loser.id,
			duplicateSourceAuthority: loser.source_authority,
		}),
	});
}

async function loadAccountMappings() {
	const rows = await getDb()
		.selectFrom("finance_account_mappings")
		.selectAll()
		.execute();
	const mappings = new Map<string, AccountMapping>();
	for (const row of rows) {
		const raw = safeJsonParse<Record<string, unknown>>(row.source_json, {});
		mappings.set(row.mapping_key, {
			mappingKey: row.mapping_key,
			book: row.book,
			debitAccount:
				row.debit_account ??
				(typeof raw.debitAccount === "string" ? raw.debitAccount : null),
			creditAccount:
				row.credit_account ??
				(typeof raw.creditAccount === "string" ? raw.creditAccount : null),
			currency: row.currency,
			confidence: row.confidence,
			raw,
		});
	}
	return mappings;
}

export async function rebuildFinanceKnowledge() {
	const db = getDb();
	const mappings = await loadAccountMappings();
	const now = nowIso();
	const entries = new Map<string, LedgerEntryDraft>();
	const sources: LedgerSourceDraft[] = [];

	const emailRows = await db
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
			"messages.received_at",
			"messages.subject",
			"message_labels.label_json",
		])
		.where("message_secondary_heads.classifier_key", "=", "finance_intel")
		.where("message_secondary_results.schema_version", "=", "finance-intel.v3")
		.where("message_secondary_heads.status", "in", ["ready", "review"])
		.orderBy("message_secondary_heads.message_id", "asc")
		.execute();

	for (const row of emailRows) {
		const financeIntel = parseCurrentFinanceIntel(
			safeJsonParse(row.result_json, null),
		);
		const rootLabel = parseCurrentMessageLabel(
			safeJsonParse(row.label_json, null),
		);
		if (!financeIntel || !rootLabel?.finance.relevant) {
			continue;
		}

		for (const [
			transactionIndex,
			transaction,
		] of financeIntel.transactionCandidates.entries()) {
			const mapping = accountFromMapping(
				mappings,
				transaction.beancount.mappingKey,
			);
			const debitAccount =
				transaction.beancount.debitAccount ?? mapping?.debitAccount ?? null;
			const creditAccount =
				transaction.beancount.creditAccount ?? mapping?.creditAccount ?? null;
			const currency =
				transaction.currency ??
				transaction.beancount.currency ??
				mapping?.currency ??
				null;
			const amountMinor = parseAmountMinor(transaction.amount);
			const originalOccurredAt = transaction.occurredAt;
			let postedAt = transaction.postedAt;
			const clearedAt = transaction.clearedAt;
			const existingExactDate = resolveLedgerDateForComposite({
				occurredAt: originalOccurredAt,
				postedAt,
				clearedAt,
			});
			const shouldRecoverPostedAt =
				!existingExactDate &&
				["month", "year"].includes(
					precisionForLedgerDate(originalOccurredAt),
				) &&
				Boolean(resolveLedgerDateForComposite({ postedAt: row.received_at }));
			const dateRecovery = shouldRecoverPostedAt
				? dateRecoveryMetadata({
						originalOccurredAt,
						originalPostedAt: postedAt,
						originalClearedAt: clearedAt,
						recoveredField: "posted_at",
						recoveredFrom: "message_received_at",
						recoveredValue: row.received_at ?? null,
						sourceMessageReceivedAt: row.received_at ?? null,
					})
				: null;
			if (shouldRecoverPostedAt) {
				postedAt = row.received_at;
			}
			const compositeDate = resolveLedgerDateForComposite({
				occurredAt: originalOccurredAt,
				postedAt,
				clearedAt,
			});
			const composite =
				transaction.dedupe.normalizedComposite ??
				normalizedComposite({
					book: transaction.book,
					account: transaction.financialAccountRef,
					date: compositeDate,
					amount: transaction.amount,
					currency,
					counterparty: transaction.merchantOrCounterparty,
				});
			const key = canonicalKey({
				source: "email",
				institution: transaction.institutionRef,
				account: transaction.financialAccountRef,
				externalTransactionId: transaction.externalTransactionId,
				messageId: row.message_id,
				messageEvidenceKey:
					transaction.dedupe.emailEvidenceKey ??
					financeIntel.dedupe.messageEvidenceKey,
				composite,
			});
			const status = statusForDraft({
				sourceConfidence: financeIntel.confidence.overall,
				ledgerStatus: financeIntel.ledgerReadiness.status,
				book: transaction.book,
				businessUsePercent: transaction.businessUsePercent,
				amountMinor,
				beancountDate: compositeDate?.slice(0, 10) ?? null,
				counterparty: transaction.merchantOrCounterparty,
				debitAccount,
				creditAccount,
				currency,
			});
			const entry: LedgerEntryDraft = {
				id: randomUUID(),
				canonical_key: key,
				status,
				source_authority: "email",
				occurred_at: originalOccurredAt,
				occurred_at_precision: precisionForLedgerDate(originalOccurredAt),
				posted_at: postedAt,
				posted_at_precision: precisionForLedgerDate(postedAt),
				cleared_at: clearedAt,
				cleared_at_precision: precisionForLedgerDate(clearedAt),
				description: transaction.evidence,
				counterparty: transaction.merchantOrCounterparty,
				direction: transaction.direction,
				amount_value: transaction.amount,
				amount_minor: amountMinor,
				currency,
				book: transaction.book,
				business_use_percent: transaction.businessUsePercent,
				debit_account: debitAccount,
				credit_account: creditAccount,
				account_mapping_key: transaction.beancount.mappingKey,
				field_confidence_json: jsonText(transaction.fieldConfidence),
				ledger_metadata_json: jsonText(
					metadataWithDateRecovery(
						{
							categoryPrimary: transaction.categoryPrimary ?? "uncategorized",
							categorySecondary: transaction.categorySecondary,
							ownerIdentityId: transaction.ownerIdentityRef,
							financialAccountId: transaction.financialAccountRef,
							institutionId: transaction.institutionRef,
							rootFinanceSignal: rootLabel.finance.signal,
							subject: row.subject,
						},
						dateRecovery,
					),
				),
				raw_payload_json: jsonText(transaction),
				created_at: now,
				updated_at: now,
			};
			addOrMerge(entries, sources, entry, {
				id: randomUUID(),
				source_kind: "email",
				message_id: row.message_id,
				secondary_result_id: row.secondary_result_id,
				import_run_id: null,
				import_transaction_id: null,
				import_document_id: null,
				evidence_json: jsonText({
					type: "transaction",
					transactionIndex,
					evidence: transaction.evidence,
					subject: row.subject,
				}),
				created_at: now,
			});
		}
	}

	const importRows = await db
		.selectFrom("finance_import_transactions")
		.innerJoin(
			"finance_import_runs",
			"finance_import_runs.id",
			"finance_import_transactions.import_run_id",
		)
		.selectAll("finance_import_transactions")
		.select([
			"finance_import_runs.source_kind as import_source_kind",
			"finance_import_runs.artifact_sha256",
		])
		.orderBy("finance_import_transactions.created_at", "asc")
		.execute();

	for (const row of importRows) {
		const importSourceKind = normalizeFinanceImportSourceKind(
			row.import_source_kind,
		);
		const mapping = accountFromMapping(mappings, row.account_mapping_key);
		const compositeDate = resolveLedgerDateForComposite({
			occurredAt: row.occurred_at,
			postedAt: row.posted_at,
			clearedAt: row.cleared_at,
		});
		const currency = row.currency ?? mapping?.currency ?? null;
		const composite = normalizedComposite({
			book: row.book_hint,
			account: row.financial_account_hint,
			date: compositeDate,
			amount: row.amount_value,
			currency,
			counterparty: row.merchant_or_counterparty ?? row.description,
		});
		const key = canonicalKey({
			source: "import",
			institution: row.institution_hint,
			account: row.financial_account_hint,
			externalTransactionId: row.external_transaction_id,
			artifactSha256: row.artifact_sha256,
			statementRowId: row.statement_row_id,
			rowIndex: row.row_index,
			composite,
		});
		const compositeKey = compositeCanonicalKey(composite);
		const canonical_key =
			!row.external_transaction_id && entries.has(compositeKey)
				? compositeKey
				: key;
		const status = statusForDraft({
			sourceConfidence: row.extraction_confidence,
			ledgerStatus: null,
			book: row.book_hint,
			businessUsePercent: row.business_use_percent,
			amountMinor: row.amount_minor,
			beancountDate: compositeDate?.slice(0, 10) ?? null,
			counterparty: row.merchant_or_counterparty ?? row.description,
			debitAccount: mapping?.debitAccount ?? null,
			creditAccount: mapping?.creditAccount ?? null,
			currency,
		});
		const entry: LedgerEntryDraft = {
			id: randomUUID(),
			canonical_key,
			status,
			source_authority: importSourceKind,
			occurred_at: row.occurred_at,
			occurred_at_precision: precisionForLedgerDate(row.occurred_at),
			posted_at: row.posted_at,
			posted_at_precision: precisionForLedgerDate(row.posted_at),
			cleared_at: row.cleared_at,
			cleared_at_precision: precisionForLedgerDate(row.cleared_at),
			description: row.description,
			counterparty: row.merchant_or_counterparty ?? row.description,
			direction: row.direction,
			amount_value: row.amount_value,
			amount_minor: row.amount_minor,
			currency,
			book: row.book_hint,
			business_use_percent: row.business_use_percent,
			debit_account: mapping?.debitAccount ?? null,
			credit_account: mapping?.creditAccount ?? null,
			account_mapping_key: row.account_mapping_key,
			field_confidence_json: jsonText({
				amount: row.amount_minor === null ? 0 : row.extraction_confidence,
				date: compositeDate ? row.extraction_confidence : 0,
				counterparty:
					row.merchant_or_counterparty || row.description
						? row.extraction_confidence
						: 0,
				accountMapping: mapping ? mapping.confidence : 0,
				book: row.book_hint === "unknown" ? 0 : row.extraction_confidence,
				category: row.category_primary ? row.extraction_confidence : 0,
				dedupe:
					row.external_transaction_id || row.statement_row_id
						? row.extraction_confidence
						: 0,
			}),
			ledger_metadata_json: jsonText({
				categoryPrimary: row.category_primary ?? "uncategorized",
				categorySecondary: row.category_secondary,
				ownerIdentityId: row.owner_identity_hint,
				financialAccountId: row.financial_account_hint,
				institutionId: row.institution_hint,
				statementRowId: row.statement_row_id,
				rowIndex: row.row_index,
			}),
			raw_payload_json: row.raw_row_payload_json,
			created_at: now,
			updated_at: now,
		};
		addOrMerge(entries, sources, entry, {
			id: randomUUID(),
			source_kind: importSourceKind,
			message_id: null,
			secondary_result_id: null,
			import_run_id: row.import_run_id,
			import_transaction_id: row.id,
			import_document_id: null,
			evidence_json: jsonText({
				type: "import_transaction",
				sourceDocumentRef: row.source_document_ref,
				evidence: row.evidence_text,
			}),
			created_at: now,
		});
	}

	const { reapplyActiveFinanceLedgerOverrides } = await import(
		"#/lib/finance-ledger-overrides"
	);
	await reapplyActiveFinanceLedgerOverrides(
		entries as unknown as Map<string, Record<string, unknown>>,
	);

	const patternRows = buildFinancePatterns([...entries.values()], now);

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("finance_ledger_entry_sources").execute();
		await trx.deleteFrom("finance_ledger_entries").execute();
		await trx.deleteFrom("finance_patterns").execute();
		const entryRows = [...entries.values()];
		if (entryRows.length > 0) {
			await trx
				.insertInto("finance_ledger_entries")
				.values(entryRows)
				.execute();
		}
		if (sources.length > 0) {
			await trx
				.insertInto("finance_ledger_entry_sources")
				.values(sources)
				.execute();
		}
		if (patternRows.length > 0) {
			await trx.insertInto("finance_patterns").values(patternRows).execute();
		}
	});

	return {
		entries: entries.size,
		ready: [...entries.values()].filter((entry) => entry.status === "ready")
			.length,
		review: [...entries.values()].filter((entry) => entry.status === "review")
			.length,
		blocked: [...entries.values()].filter((entry) => entry.status === "blocked")
			.length,
		evidence: sources.length,
		patterns: patternRows.length,
		events: entries.size,
		documents: 0,
	};
}

function buildFinancePatterns(entries: LedgerEntryDraft[], now: string) {
	const groups = new Map<string, LedgerEntryDraft[]>();
	for (const entry of entries) {
		const counterparty = normalizeKeyPart(entry.counterparty);
		if (!counterparty) {
			continue;
		}
		const key = `${entry.book}:${counterparty}`;
		groups.set(key, [...(groups.get(key) ?? []), entry]);
	}
	return [...groups.entries()]
		.filter(([, rows]) => rows.length >= 2)
		.map(([key, rows]) => ({
			id: randomUUID(),
			pattern_kind: "recurring_merchant",
			pattern_key: key,
			status: "active",
			confidence: Math.min(0.95, 0.5 + rows.length * 0.1),
			summary_json: jsonText({
				counterparty: rows[0]?.counterparty,
				book: rows[0]?.book,
				transactionCount: rows.length,
				canonicalKeys: rows.map((row) => row.canonical_key),
			}),
			first_seen_at:
				rows
					.map(
						(row) =>
							resolveLedgerDateForComposite({
								occurredAt: row.occurred_at,
								postedAt: row.posted_at,
								clearedAt: row.cleared_at,
							}) ??
							row.occurred_at ??
							row.posted_at,
					)
					.filter((value): value is string => Boolean(value))
					.sort()[0] ?? null,
			last_seen_at:
				rows
					.map(
						(row) =>
							resolveLedgerDateForComposite({
								occurredAt: row.occurred_at,
								postedAt: row.posted_at,
								clearedAt: row.cleared_at,
							}) ??
							row.occurred_at ??
							row.posted_at,
					)
					.filter((value): value is string => Boolean(value))
					.sort()
					.at(-1) ?? null,
			created_at: now,
			updated_at: now,
		}));
}
