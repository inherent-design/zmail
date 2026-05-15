import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
	FINANCE_INTEL_PROMPT_VERSION,
	FINANCE_KNOWLEDGE_PROMPT_VERSION,
	nowIso,
} from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { parseAmountMinor } from "#/lib/finance-imports";
import { precisionForLedgerDate } from "#/lib/finance-ledger-dates";
import { queueJobIdempotent } from "#/lib/jobs";

const financeLedgerOverridePatchSchema = z
	.object({
		status: z.string().min(1).max(80).optional(),
		occurredAt: z.string().min(1).max(64).nullable().optional(),
		postedAt: z.string().min(1).max(64).nullable().optional(),
		clearedAt: z.string().min(1).max(64).nullable().optional(),
		description: z.string().min(1).max(500).nullable().optional(),
		counterparty: z.string().min(1).max(240).nullable().optional(),
		amountValue: z.string().min(1).max(64).nullable().optional(),
		direction: z.string().min(1).max(80).optional(),
		currency: z.string().min(1).max(16).nullable().optional(),
		book: z.string().min(1).max(80).optional(),
		businessUsePercent: z.number().min(0).max(100).nullable().optional(),
		categoryPrimary: z.string().min(1).max(120).optional(),
		categorySecondary: z.string().min(1).max(120).nullable().optional(),
		accountMappingKey: z.string().min(1).max(240).nullable().optional(),
		debitAccount: z.string().min(1).max(240).nullable().optional(),
		creditAccount: z.string().min(1).max(240).nullable().optional(),
	})
	.strict();

const financeLedgerRelationshipPatchSchema = z
	.object({
		ownerIdentityId: z.string().min(1).max(240).nullable().optional(),
		financialAccountId: z.string().min(1).max(240).nullable().optional(),
		institutionId: z.string().min(1).max(240).nullable().optional(),
		relatedCanonicalKeys: z.array(z.string().min(1).max(500)).optional(),
		relatedMessageIds: z.array(z.string().min(1).max(240)).optional(),
		relatedImportRunIds: z.array(z.string().min(1).max(240)).optional(),
		relatedImportDocumentIds: z.array(z.string().min(1).max(240)).optional(),
		relatedImportTransactionIds: z.array(z.string().min(1).max(240)).optional(),
	})
	.strict();

export const applyFinanceLedgerOverrideInputSchema = z
	.object({
		canonicalKey: z.string().min(1).max(500),
		patch: financeLedgerOverridePatchSchema.default({}),
		relationshipPatch: financeLedgerRelationshipPatchSchema.default({}),
		note: z.string().min(1).max(1000).nullable().optional(),
		actorRef: z.string().min(1).max(240),
		reclassify: z.boolean().default(false),
	})
	.strict();

export const revertFinanceLedgerOverrideInputSchema = z
	.object({
		overrideId: z.string().min(1).max(240),
		actorRef: z.string().min(1).max(240),
	})
	.strict();

type OverridePatch = z.infer<typeof financeLedgerOverridePatchSchema>;
type RelationshipPatch = z.infer<typeof financeLedgerRelationshipPatchSchema>;

function mergeMetadata(
	raw: string,
	patch: OverridePatch,
	relationshipPatch: RelationshipPatch,
) {
	const metadata = safeJsonParse<Record<string, unknown>>(raw, {});
	if (patch.categoryPrimary !== undefined) {
		metadata.categoryPrimary = patch.categoryPrimary;
	}
	if (patch.categorySecondary !== undefined) {
		metadata.categorySecondary = patch.categorySecondary;
	}
	for (const key of [
		"ownerIdentityId",
		"financialAccountId",
		"institutionId",
	] as const) {
		if (relationshipPatch[key] !== undefined) {
			metadata[key] = relationshipPatch[key];
		}
	}
	if (Object.keys(relationshipPatch).length > 0) {
		metadata.manualRelationships = {
			...(safeJsonParse<Record<string, unknown>>(
				JSON.stringify(metadata.manualRelationships ?? {}),
				{},
			) ?? {}),
			...relationshipPatch,
		};
	}
	return jsonText(metadata);
}

function dbPatch(patch: OverridePatch, currentMetadataJson: string) {
	const set: Record<string, unknown> = {};
	if (patch.status !== undefined) set.status = patch.status;
	if (patch.occurredAt !== undefined) {
		set.occurred_at = patch.occurredAt;
		set.occurred_at_precision = precisionForLedgerDate(patch.occurredAt);
	}
	if (patch.postedAt !== undefined) {
		set.posted_at = patch.postedAt;
		set.posted_at_precision = precisionForLedgerDate(patch.postedAt);
	}
	if (patch.clearedAt !== undefined) {
		set.cleared_at = patch.clearedAt;
		set.cleared_at_precision = precisionForLedgerDate(patch.clearedAt);
	}
	if (patch.description !== undefined) set.description = patch.description;
	if (patch.counterparty !== undefined) set.counterparty = patch.counterparty;
	if (patch.amountValue !== undefined) {
		set.amount_value = patch.amountValue;
		set.amount_minor = parseAmountMinor(patch.amountValue);
	}
	if (patch.direction !== undefined) set.direction = patch.direction;
	if (patch.currency !== undefined) set.currency = patch.currency;
	if (patch.book !== undefined) set.book = patch.book;
	if (patch.businessUsePercent !== undefined) {
		set.business_use_percent = patch.businessUsePercent;
	}
	if (patch.accountMappingKey !== undefined) {
		set.account_mapping_key = patch.accountMappingKey;
	}
	if (patch.debitAccount !== undefined) set.debit_account = patch.debitAccount;
	if (patch.creditAccount !== undefined)
		set.credit_account = patch.creditAccount;
	if (
		patch.categoryPrimary !== undefined ||
		patch.categorySecondary !== undefined
	) {
		set.ledger_metadata_json = mergeMetadata(currentMetadataJson, patch, {});
	}
	return set;
}

function affectsRollups(patch: OverridePatch) {
	return [
		"status",
		"occurredAt",
		"postedAt",
		"clearedAt",
		"amountValue",
		"direction",
		"categoryPrimary",
		"categorySecondary",
		"book",
	].some((key) => Object.hasOwn(patch, key));
}

async function queueReclassificationForLedgerRow(input: {
	ledgerEntryId: string;
	canonicalKey: string;
}) {
	const db = getDb();
	const rows = await db
		.selectFrom("finance_ledger_entry_sources")
		.innerJoin(
			"messages",
			"messages.id",
			"finance_ledger_entry_sources.message_id",
		)
		.select([
			"finance_ledger_entry_sources.message_id as message_id",
			"messages.account_id as account_id",
		])
		.where(
			"finance_ledger_entry_sources.ledger_entry_id",
			"=",
			input.ledgerEntryId,
		)
		.where("finance_ledger_entry_sources.message_id", "is not", null)
		.execute();
	if (rows.length === 0) {
		const jobId = await queueJobIdempotent({
			kind: "rebuild_finance_knowledge",
			scopeType: "system",
			scopeId: "finance",
			promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
		});
		return jobId ? [jobId] : [];
	}
	const byAccount = new Map<string, string[]>();
	for (const row of rows) {
		if (!row.account_id || !row.message_id) {
			continue;
		}
		byAccount.set(row.account_id, [
			...(byAccount.get(row.account_id) ?? []),
			row.message_id,
		]);
	}
	const jobs: string[] = [];
	for (const [accountId, messageIds] of byAccount) {
		const jobId = await queueJobIdempotent({
			kind: "classify_finance_messages",
			scopeType: "account",
			scopeId: accountId,
			promptVersion: FINANCE_INTEL_PROMPT_VERSION,
			meta: { targetMessageIds: Array.from(new Set(messageIds)) },
		});
		if (jobId) {
			jobs.push(jobId);
		}
	}
	return jobs;
}

export async function applyFinanceLedgerOverride(input: unknown) {
	const parsed = applyFinanceLedgerOverrideInputSchema.parse(input);
	const db = getDb();
	const now = nowIso();
	const overrideId = `finovr_${randomUUID()}`;
	const row = await db
		.selectFrom("finance_ledger_entries")
		.selectAll()
		.where("canonical_key", "=", parsed.canonicalKey)
		.executeTakeFirst();
	if (!row) {
		return {
			status: "not_found" as const,
			overrideId: null,
			jobs: [] as string[],
		};
	}
	const updatePatch = dbPatch(parsed.patch, row.ledger_metadata_json);
	if (Object.keys(parsed.relationshipPatch).length > 0) {
		updatePatch.ledger_metadata_json = mergeMetadata(
			String(updatePatch.ledger_metadata_json ?? row.ledger_metadata_json),
			{},
			parsed.relationshipPatch,
		);
	}
	updatePatch.updated_at = now;

	await db.transaction().execute(async (trx) => {
		await trx
			.updateTable("finance_ledger_entry_overrides")
			.set({ status: "superseded", superseded_at: now, updated_at: now })
			.where("canonical_key", "=", parsed.canonicalKey)
			.where("status", "=", "active")
			.execute();
		await trx
			.insertInto("finance_ledger_entry_overrides")
			.values({
				id: overrideId,
				canonical_key: parsed.canonicalKey,
				patch_json: jsonText(parsed.patch),
				relationship_patch_json: jsonText(parsed.relationshipPatch),
				note: parsed.note ?? null,
				actor_ref: parsed.actorRef,
				status: "active",
				created_at: now,
				updated_at: now,
				superseded_at: null,
			})
			.execute();
		await trx
			.updateTable("finance_ledger_entries")
			.set(updatePatch)
			.where("id", "=", row.id)
			.execute();
	});

	const jobs: string[] = [];
	if (affectsRollups(parsed.patch)) {
		const jobId = await queueJobIdempotent({
			kind: "rebuild_finance_rollups",
			scopeType: "system",
			scopeId: "finance_rollups",
			promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
		});
		if (jobId) {
			jobs.push(jobId);
		}
	}
	if (parsed.reclassify) {
		jobs.push(
			...(await queueReclassificationForLedgerRow({
				ledgerEntryId: row.id,
				canonicalKey: parsed.canonicalKey,
			})),
		);
	}
	return { status: "applied" as const, overrideId, jobs };
}

export async function revertFinanceLedgerOverride(input: unknown) {
	const parsed = revertFinanceLedgerOverrideInputSchema.parse(input);
	const db = getDb();
	const now = nowIso();
	const row = await db
		.selectFrom("finance_ledger_entry_overrides")
		.select(["id", "canonical_key", "status"])
		.where("id", "=", parsed.overrideId)
		.executeTakeFirst();
	if (!row) {
		return {
			status: "not_found" as const,
			canonicalKey: null,
			jobs: [] as string[],
		};
	}
	if (row.status !== "active") {
		return {
			status: "inactive" as const,
			canonicalKey: row.canonical_key,
			jobs: [] as string[],
		};
	}
	await db
		.updateTable("finance_ledger_entry_overrides")
		.set({ status: "reverted", superseded_at: now, updated_at: now })
		.where("id", "=", parsed.overrideId)
		.execute();
	const jobs = (
		await Promise.all([
			queueJobIdempotent({
				kind: "rebuild_finance_knowledge",
				scopeType: "system",
				scopeId: "finance",
				promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
			}),
			queueJobIdempotent({
				kind: "rebuild_finance_rollups",
				scopeType: "system",
				scopeId: "finance_rollups",
				promptVersion: FINANCE_KNOWLEDGE_PROMPT_VERSION,
			}),
		])
	).filter((jobId): jobId is string => Boolean(jobId));
	return { status: "reverted" as const, canonicalKey: row.canonical_key, jobs };
}

export async function reapplyActiveFinanceLedgerOverrides(
	entriesByCanonicalKey: Map<string, Record<string, unknown>>,
) {
	const db = getDb();
	const overrides = await db
		.selectFrom("finance_ledger_entry_overrides")
		.select(["canonical_key", "patch_json", "relationship_patch_json"])
		.where("status", "=", "active")
		.orderBy("updated_at", "asc")
		.execute();
	for (const override of overrides) {
		const entry = entriesByCanonicalKey.get(override.canonical_key);
		if (!entry) {
			continue;
		}
		const patch = financeLedgerOverridePatchSchema.parse(
			safeJsonParse(override.patch_json, {}),
		);
		const relationshipPatch = financeLedgerRelationshipPatchSchema.parse(
			safeJsonParse(override.relationship_patch_json, {}),
		);
		const currentMetadataJson = String(entry.ledger_metadata_json ?? "{}");
		const updatePatch = dbPatch(patch, currentMetadataJson);
		if (Object.keys(relationshipPatch).length > 0) {
			updatePatch.ledger_metadata_json = mergeMetadata(
				String(updatePatch.ledger_metadata_json ?? currentMetadataJson),
				{},
				relationshipPatch,
			);
		}
		Object.assign(entry, updatePatch);
	}
}
