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
	const artifactSha256 =
		artifact.artifactSha256 || sha256(JSON.stringify(artifact));

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
				raw_artifact_json: jsonText(artifact),
				imported_at: importedAt,
			})
			.execute();

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

	return {
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
	};
}
