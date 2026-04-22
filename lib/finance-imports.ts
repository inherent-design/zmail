import { createHash, randomUUID } from "node:crypto";

import { nowIso } from "#/lib/config";
import { getDb, jsonText } from "#/lib/db";
import {
	type FinanceSourceImport,
	financeSourceImportSchema,
} from "#/lib/schemas";

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

export function computeArtifactSha256(artifact: FinanceSourceImport) {
	if (artifact.artifactSha256.trim()) {
		return artifact.artifactSha256;
	}
	return sha256(JSON.stringify({ ...artifact, artifactSha256: "" }));
}

export function withFinalArtifactSha256<T extends FinanceSourceImport>(
	artifact: T,
) {
	const artifactSha256 = computeArtifactSha256(artifact);
	return {
		...artifact,
		artifactSha256,
	};
}

export async function findFinanceImportRunByArtifact(artifactSha256: string) {
	const db = getDb();
	const row = await db
		.selectFrom("finance_import_runs")
		.select(["id", "artifact_sha256", "imported_at"])
		.where("artifact_sha256", "=", artifactSha256)
		.orderBy("imported_at", "desc")
		.executeTakeFirst();
	return row ?? null;
}

export function parseAmountMinor(value: string | null | undefined) {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/[^0-9.-]/g, "").trim();
	if (!normalized) {
		return null;
	}
	const numeric = Number.parseFloat(normalized);
	if (!Number.isFinite(numeric)) {
		return null;
	}
	return Math.round(numeric * 100);
}

function v2RawValue(value: object, key: string) {
	return (value as Record<string, unknown>)[key];
}

function v2String(value: object, key: string) {
	const raw = v2RawValue(value, key);
	return typeof raw === "string" ? raw : null;
}

function v2Number(value: object, key: string) {
	const raw = v2RawValue(value, key);
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function v2Record(value: object, key: string) {
	const raw = v2RawValue(value, key);
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function buildSuggestionRows(input: {
	importRunId: string;
	artifact: FinanceSourceImport;
	createdAt: string;
}) {
	const rows: Array<{
		id: string;
		entity_kind: string;
		canonical_key: string;
		suggestion_json: string;
		source_kind: string;
		source_ref_id: string;
		confidence: number;
		status: string;
		applied_registry_id: string | null;
		created_at: string;
		updated_at: string;
	}> = [];

	for (const identity of input.artifact.registrySuggestions.identities) {
		rows.push({
			id: randomUUID(),
			entity_kind: "identity",
			canonical_key: identity.canonicalKey,
			suggestion_json: jsonText(identity),
			source_kind: input.artifact.sourceKind,
			source_ref_id: input.importRunId,
			confidence: identity.confidence,
			status: "pending",
			applied_registry_id: null,
			created_at: input.createdAt,
			updated_at: input.createdAt,
		});
	}

	for (const institution of input.artifact.registrySuggestions.institutions) {
		rows.push({
			id: randomUUID(),
			entity_kind: "institution",
			canonical_key: institution.canonicalKey,
			suggestion_json: jsonText(institution),
			source_kind: input.artifact.sourceKind,
			source_ref_id: input.importRunId,
			confidence: institution.confidence,
			status: "pending",
			applied_registry_id: null,
			created_at: input.createdAt,
			updated_at: input.createdAt,
		});
	}

	for (const account of input.artifact.registrySuggestions.financialAccounts) {
		rows.push({
			id: randomUUID(),
			entity_kind: "financial_account",
			canonical_key: account.canonicalKey,
			suggestion_json: jsonText(account),
			source_kind: input.artifact.sourceKind,
			source_ref_id: input.importRunId,
			confidence: account.confidence,
			status: "pending",
			applied_registry_id: null,
			created_at: input.createdAt,
			updated_at: input.createdAt,
		});
	}

	for (const rule of input.artifact.registrySuggestions.senderRules) {
		rows.push({
			id: randomUUID(),
			entity_kind: "sender_rule",
			canonical_key: rule.canonicalKey,
			suggestion_json: jsonText(rule),
			source_kind: input.artifact.sourceKind,
			source_ref_id: input.importRunId,
			confidence: rule.confidence,
			status: "pending",
			applied_registry_id: null,
			created_at: input.createdAt,
			updated_at: input.createdAt,
		});
	}

	return rows;
}

export async function importFinanceArtifact(input: unknown) {
	const artifact = financeSourceImportSchema.parse(input);
	const db = getDb();
	const importRunId = randomUUID();
	const importedAt = nowIso();
	const artifactSha256 = computeArtifactSha256(artifact);
	const storedArtifact = withFinalArtifactSha256(artifact);
	let result:
		| {
				status: "imported" | "already_imported";
				importRunId: string;
				importedAt: string;
				artifactSha256: string;
				documents: number;
				transactions: number;
				registrySuggestions: number;
		  }
		| undefined;

	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("finance_import_runs")
			.values({
				id: importRunId,
				source_kind: artifact.sourceKind,
				source_file_path: artifact.sourceFile.absolutePath,
				source_file_sha256: artifact.sourceFile.sha256,
				filename: artifact.sourceFile.filename,
				artifact_sha256: artifactSha256,
				extractor_runner: artifact.extractor.runner,
				extractor_model: artifact.extractor.model,
				extractor_prompt_version: artifact.extractor.promptVersion,
				extracted_text_hash: artifact.extractor.extractedTextHash,
				status: "imported",
				raw_artifact_json: jsonText(storedArtifact),
				imported_at: importedAt,
			})
			.onConflict((oc) => oc.column("artifact_sha256").doNothing())
			.execute();

		const importRun = await trx
			.selectFrom("finance_import_runs")
			.select(["id", "imported_at"])
			.where("artifact_sha256", "=", artifactSha256)
			.orderBy("imported_at", "desc")
			.executeTakeFirstOrThrow();
		if (importRun.id !== importRunId) {
			result = {
				status: "already_imported",
				importRunId: importRun.id,
				importedAt: importRun.imported_at,
				artifactSha256,
				documents: artifact.documents.length,
				transactions: artifact.transactions.length,
				registrySuggestions:
					artifact.registrySuggestions.identities.length +
					artifact.registrySuggestions.institutions.length +
					artifact.registrySuggestions.financialAccounts.length +
					artifact.registrySuggestions.senderRules.length,
			};
			return;
		}

		if (artifact.documents.length > 0) {
			await trx
				.insertInto("finance_import_documents")
				.values(
					artifact.documents.map((document) => ({
						id: randomUUID(),
						import_run_id: importRunId,
						source_document_ref: document.sourceDocumentRef,
						document_type: document.documentType,
						issuer: document.issuer,
						external_id: document.externalId,
						statement_period_start: document.statementPeriodStart,
						statement_period_end: document.statementPeriodEnd,
						due_at: document.dueAt,
						tax_year: document.taxYear,
						owner_identity_hint: document.ownerIdentityHint,
						financial_account_hint: document.financialAccountHint,
						institution_hint: document.institutionHint,
						evidence_text: document.evidenceText,
						payload_json: jsonText(document),
						statement_opening_balance: v2String(
							document,
							"statementOpeningBalance",
						),
						statement_closing_balance: v2String(
							document,
							"statementClosingBalance",
						),
						statement_transaction_count: v2Number(
							document,
							"statementTransactionCount",
						),
						statement_currency: v2String(document, "statementCurrency"),
						account_mapping_key: v2String(document, "accountMappingKey"),
						extraction_confidence:
							v2Number(document, "extractionConfidence") ?? 0,
						raw_document_payload_json: jsonText(
							v2Record(document, "rawPayload"),
						),
						raw_payload_json: jsonText(v2Record(document, "rawPayload")),
						created_at: importedAt,
					})),
				)
				.execute();
		}

		if (artifact.transactions.length > 0) {
			await trx
				.insertInto("finance_import_transactions")
				.values(
					artifact.transactions.map((transaction) => ({
						id: randomUUID(),
						import_run_id: importRunId,
						source_document_ref: transaction.sourceDocumentRef,
						occurred_at: transaction.occurredAt,
						posted_at: transaction.postedAt,
						amount_value: transaction.amount,
						amount_minor: parseAmountMinor(transaction.amount),
						currency: transaction.currency,
						direction: transaction.direction,
						description: transaction.description,
						merchant_or_counterparty: transaction.merchantOrCounterparty,
						balance_value: transaction.balance,
						owner_identity_hint: transaction.ownerIdentityHint,
						financial_account_hint: transaction.financialAccountHint,
						institution_hint: transaction.institutionHint,
						category_primary: transaction.categoryPrimary,
						category_secondary: transaction.categorySecondary,
						evidence_text: transaction.evidenceText,
						payload_json: jsonText(transaction),
						external_transaction_id: v2String(
							transaction,
							"externalTransactionId",
						),
						cleared_at: v2String(transaction, "clearedAt"),
						statement_row_id: v2String(transaction, "statementRowId"),
						row_index: v2Number(transaction, "rowIndex"),
						account_mapping_key: v2String(transaction, "accountMappingKey"),
						book_hint: v2String(transaction, "bookHint") ?? "unknown",
						business_use_percent: v2Number(transaction, "businessUsePercent"),
						extraction_confidence:
							v2Number(transaction, "extractionConfidence") ?? 0,
						raw_row_payload_json: jsonText(v2Record(transaction, "rawPayload")),
						row_provenance_json: jsonText(
							v2Record(transaction, "rowProvenance"),
						),
						raw_payload_json: jsonText(v2Record(transaction, "rawPayload")),
						created_at: importedAt,
					})),
				)
				.execute();
		}

		const suggestionRows = buildSuggestionRows({
			importRunId,
			artifact,
			createdAt: importedAt,
		});
		if (suggestionRows.length > 0) {
			await trx
				.insertInto("registry_suggestions")
				.values(suggestionRows)
				.execute();
		}
	});

	return (
		result ?? {
			status: "imported",
			importRunId,
			importedAt,
			artifactSha256,
			documents: artifact.documents.length,
			transactions: artifact.transactions.length,
			registrySuggestions:
				artifact.registrySuggestions.identities.length +
				artifact.registrySuggestions.institutions.length +
				artifact.registrySuggestions.financialAccounts.length +
				artifact.registrySuggestions.senderRules.length,
		}
	);
}
