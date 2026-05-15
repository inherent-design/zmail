import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureStorageDirs, nowIso } from "#/lib/config";
import {
	defaultMigrationTargetOrgIds,
	ensureAccountOwnershipBackfill,
	getDb,
	getSqlite,
	runMigrations,
	safeJsonParse,
} from "#/lib/db";
import {
	dateRecoveryMetadata,
	precisionForLedgerDate,
	resolveLedgerDateForComposite,
	toBeancountDate,
} from "#/lib/finance-ledger-dates";
import type { LogTrace } from "#/lib/log";
import { dataRootDir, runWithOrgContext } from "#/lib/runtime";
import { runCli } from "#/scripts/_shared";

interface ParsedArgs {
	allOrgs: boolean;
	confirm: boolean;
	dryRun: boolean;
	orgId?: string;
}

interface CandidateRow {
	id: string;
	canonical_key: string;
	status: string;
	book: string;
	occurred_at: string | null;
	occurred_at_precision: string;
	posted_at: string | null;
	posted_at_precision: string;
	cleared_at: string | null;
	cleared_at_precision: string;
	amount_value: string | null;
	currency: string | null;
	counterparty: string | null;
	ledger_metadata_json: string;
	updated_at: string;
}

interface CandidateContextRow {
	ledger_entry_id: string | null;
	message_id: string | null;
	received_at: string | null;
	raw_rfc822_path: string | null;
}

interface CandidatePlan {
	id: string;
	oldCanonicalKey: string;
	targetCanonicalKey: string;
	postedAt: string | null;
	postedAtPrecision: string;
	ledgerMetadataJson: string;
	status: "recoverable" | "collision" | "blocked";
	reason: string | null;
	beancountDate: string | null;
	dateRecovery: Record<string, unknown> | null;
}

function isoTimestampLabel(value = nowIso()) {
	return value.replace(/[:.]/g, "-");
}

function normalizeCompositeKeyPart(value: string | null | undefined) {
	return (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function safeTargetCanonicalKey(
	row: CandidateRow,
	beancountDate: string | null,
) {
	try {
		if (!row.canonical_key.startsWith("composite:")) {
			return row.canonical_key;
		}
		const metadata = safeJsonParse<Record<string, unknown>>(
			row.ledger_metadata_json,
			{},
		);
		const financialAccountId =
			typeof metadata.financialAccountId === "string"
				? metadata.financialAccountId
				: null;
		return `composite:${[
			row.book,
			financialAccountId ?? "unknown-account",
			beancountDate ?? "",
			normalizeCompositeKeyPart(row.amount_value),
			(row.currency ?? "").toUpperCase(),
			normalizeCompositeKeyPart(row.counterparty),
		].join("|")}`;
	} catch {
		return null;
	}
}

function extractRawDateHeader(rawPath: string) {
	const raw = readFileSync(rawPath, "utf8");
	const headerBlock = raw.split(/\r?\n\r?\n/u, 1)[0] ?? raw;
	const match = headerBlock.match(/^Date:\s*(.+)$/imu);
	return match?.[1]?.trim() ?? null;
}

function verifiedMessageReceivedAt(input: {
	rawRfc822Path: string | null;
	receivedAt: string | null;
}) {
	const beancountDate = toBeancountDate(input.receivedAt);
	if (!beancountDate) {
		return {
			ok: false as const,
			reason: "missing_exact_source_message_date",
			rawHeaderDate: null,
		};
	}
	if (!input.rawRfc822Path) {
		return { ok: true as const, rawHeaderDate: null };
	}

	let rawHeaderDate: string | null = null;
	try {
		rawHeaderDate = extractRawDateHeader(input.rawRfc822Path);
	} catch {
		return { ok: true as const, rawHeaderDate: null };
	}

	if (!rawHeaderDate) {
		return { ok: true as const, rawHeaderDate: null };
	}

	const parsedHeaderDate = new Date(rawHeaderDate);
	if (Number.isNaN(parsedHeaderDate.getTime())) {
		return {
			ok: false as const,
			reason: "invalid_raw_date_header",
			rawHeaderDate,
		};
	}
	const rawHeaderDay = parsedHeaderDate.toISOString().slice(0, 10);
	if (rawHeaderDay !== beancountDate) {
		return {
			ok: false as const,
			reason: "raw_date_header_mismatch",
			rawHeaderDate,
		};
	}
	return { ok: true as const, rawHeaderDate };
}

function mergeLedgerMetadataJson(input: {
	currentMetadataJson: string;
	dateRecovery: Record<string, unknown> | null;
}) {
	const metadata = safeJsonParse<Record<string, unknown>>(
		input.currentMetadataJson,
		{},
	);
	if (!input.dateRecovery) {
		return JSON.stringify(metadata);
	}
	return JSON.stringify({
		...metadata,
		dateRecovery: input.dateRecovery,
	});
}

function existingDateRecovery(metadataJson: string) {
	const metadata = safeJsonParse<Record<string, unknown>>(metadataJson, {});
	return metadata.dateRecovery &&
		typeof metadata.dateRecovery === "object" &&
		!Array.isArray(metadata.dateRecovery)
		? (metadata.dateRecovery as Record<string, unknown>)
		: null;
}

function candidateNeedsRepair(row: CandidateRow) {
	return [
		row.occurred_at_precision,
		row.posted_at_precision,
		row.cleared_at_precision,
	].some((precision) => precision === "month" || precision === "year");
}

function groupCandidateContext(rows: CandidateContextRow[]) {
	const byEntry = new Map<
		string,
		{
			messageIds: Set<string>;
			receivedAtByMessage: Map<string, string | null>;
			rawPathsByMessage: Map<string, Set<string>>;
		}
	>();

	for (const row of rows) {
		if (!row.ledger_entry_id) {
			continue;
		}
		const current = byEntry.get(row.ledger_entry_id) ?? {
			messageIds: new Set<string>(),
			receivedAtByMessage: new Map<string, string | null>(),
			rawPathsByMessage: new Map<string, Set<string>>(),
		};
		if (row.message_id) {
			current.messageIds.add(row.message_id);
			current.receivedAtByMessage.set(row.message_id, row.received_at ?? null);
			const paths = current.rawPathsByMessage.get(row.message_id) ?? new Set();
			if (row.raw_rfc822_path) {
				paths.add(row.raw_rfc822_path);
			}
			current.rawPathsByMessage.set(row.message_id, paths);
		}
		byEntry.set(row.ledger_entry_id, current);
	}

	return byEntry;
}

async function buildCandidatePlans(orgId: string) {
	const db = getDb(orgId);
	const candidates = (await db
		.selectFrom("finance_ledger_entries")
		.select([
			"id",
			"canonical_key",
			"status",
			"book",
			"occurred_at",
			"occurred_at_precision",
			"posted_at",
			"posted_at_precision",
			"cleared_at",
			"cleared_at_precision",
			"amount_value",
			"currency",
			"counterparty",
			"ledger_metadata_json",
			"updated_at",
		])
		.where("status", "=", "ready")
		.execute()) as CandidateRow[];
	const partialCandidates = candidates.filter(candidateNeedsRepair);

	if (partialCandidates.length === 0) {
		return {
			candidates: partialCandidates,
			plans: [] as CandidatePlan[],
		};
	}

	const candidateIds = partialCandidates.map((row) => row.id);
	const contextRows = (await db
		.selectFrom("finance_ledger_entry_sources")
		.leftJoin(
			"messages",
			"messages.id",
			"finance_ledger_entry_sources.message_id",
		)
		.leftJoin(
			"message_sources",
			"message_sources.message_id",
			"finance_ledger_entry_sources.message_id",
		)
		.select([
			"finance_ledger_entry_sources.ledger_entry_id as ledger_entry_id",
			"finance_ledger_entry_sources.message_id as message_id",
			"messages.received_at as received_at",
			"message_sources.raw_rfc822_path as raw_rfc822_path",
		])
		.where("finance_ledger_entry_sources.ledger_entry_id", "in", candidateIds)
		.execute()) as CandidateContextRow[];
	const contextByEntry = groupCandidateContext(contextRows);

	const plans: CandidatePlan[] = partialCandidates.map((candidate) => {
		const context = contextByEntry.get(candidate.id);
		if (!context || context.messageIds.size !== 1) {
			return {
				id: candidate.id,
				oldCanonicalKey: candidate.canonical_key,
				targetCanonicalKey: candidate.canonical_key,
				postedAt: candidate.posted_at,
				postedAtPrecision: candidate.posted_at_precision,
				ledgerMetadataJson: candidate.ledger_metadata_json,
				status: "blocked",
				reason: "ambiguous_source_message",
				beancountDate: null,
				dateRecovery: null,
			};
		}

		const messageId = [...context.messageIds][0] ?? "";
		const rawPaths = [
			...(context.rawPathsByMessage.get(messageId) ?? new Set()),
		];
		if (rawPaths.length > 1) {
			return {
				id: candidate.id,
				oldCanonicalKey: candidate.canonical_key,
				targetCanonicalKey: candidate.canonical_key,
				postedAt: candidate.posted_at,
				postedAtPrecision: candidate.posted_at_precision,
				ledgerMetadataJson: candidate.ledger_metadata_json,
				status: "blocked",
				reason: "ambiguous_message_source",
				beancountDate: null,
				dateRecovery: null,
			};
		}

		const existingExactDate = resolveLedgerDateForComposite({
			occurredAt: candidate.occurred_at,
			postedAt: candidate.posted_at,
			clearedAt: candidate.cleared_at,
		});
		if (existingExactDate) {
			const targetCanonicalKey = safeTargetCanonicalKey(
				candidate,
				toBeancountDate(existingExactDate),
			);
			if (!targetCanonicalKey) {
				return {
					id: candidate.id,
					oldCanonicalKey: candidate.canonical_key,
					targetCanonicalKey: candidate.canonical_key,
					postedAt: candidate.posted_at,
					postedAtPrecision: candidate.posted_at_precision,
					ledgerMetadataJson: candidate.ledger_metadata_json,
					status: "blocked",
					reason: "invalid_composite_canonical_key",
					beancountDate: null,
					dateRecovery: null,
				};
			}
			return {
				id: candidate.id,
				oldCanonicalKey: candidate.canonical_key,
				targetCanonicalKey,
				postedAt: candidate.posted_at,
				postedAtPrecision: precisionForLedgerDate(candidate.posted_at),
				ledgerMetadataJson: candidate.ledger_metadata_json,
				status: "recoverable",
				reason: null,
				beancountDate: toBeancountDate(existingExactDate),
				dateRecovery: existingDateRecovery(candidate.ledger_metadata_json),
			};
		}

		const receivedAt = context.receivedAtByMessage.get(messageId) ?? null;
		const verified = verifiedMessageReceivedAt({
			rawRfc822Path: rawPaths[0] ?? null,
			receivedAt,
		});
		if (!verified.ok) {
			return {
				id: candidate.id,
				oldCanonicalKey: candidate.canonical_key,
				targetCanonicalKey: candidate.canonical_key,
				postedAt: candidate.posted_at,
				postedAtPrecision: candidate.posted_at_precision,
				ledgerMetadataJson: candidate.ledger_metadata_json,
				status: "blocked",
				reason: verified.reason,
				beancountDate: null,
				dateRecovery: null,
			};
		}

		const dateRecovery = dateRecoveryMetadata({
			existing: existingDateRecovery(candidate.ledger_metadata_json),
			originalOccurredAt: candidate.occurred_at,
			originalPostedAt: candidate.posted_at,
			originalClearedAt: candidate.cleared_at,
			recoveredField: "posted_at",
			recoveredFrom: "message_received_at",
			recoveredValue: receivedAt,
			sourceMessageReceivedAt: receivedAt,
			sourceRawHeaderDate: verified.rawHeaderDate,
			note: "repair_finance_ledger_dates",
		});
		const targetCanonicalKey = safeTargetCanonicalKey(
			candidate,
			toBeancountDate(receivedAt),
		);
		if (!targetCanonicalKey) {
			return {
				id: candidate.id,
				oldCanonicalKey: candidate.canonical_key,
				targetCanonicalKey: candidate.canonical_key,
				postedAt: candidate.posted_at,
				postedAtPrecision: candidate.posted_at_precision,
				ledgerMetadataJson: candidate.ledger_metadata_json,
				status: "blocked",
				reason: "invalid_composite_canonical_key",
				beancountDate: null,
				dateRecovery: null,
			};
		}
		return {
			id: candidate.id,
			oldCanonicalKey: candidate.canonical_key,
			targetCanonicalKey,
			postedAt: receivedAt,
			postedAtPrecision: precisionForLedgerDate(receivedAt),
			ledgerMetadataJson: mergeLedgerMetadataJson({
				currentMetadataJson: candidate.ledger_metadata_json,
				dateRecovery,
			}),
			status: "recoverable",
			reason: null,
			beancountDate: toBeancountDate(receivedAt),
			dateRecovery,
		};
	});

	const recoverablePlans = plans.filter(
		(plan) => plan.status === "recoverable",
	);
	const targetKeys = recoverablePlans.map((plan) => plan.targetCanonicalKey);
	const existingRows =
		targetKeys.length > 0
			? await db
					.selectFrom("finance_ledger_entries")
					.select(["id", "canonical_key"])
					.where("canonical_key", "in", targetKeys)
					.execute()
			: [];
	const existingByCanonicalKey = new Map(
		existingRows.map((row) => [row.canonical_key, row.id]),
	);
	const overrideKeys = Array.from(
		new Set(
			recoverablePlans.flatMap((plan) => [
				plan.oldCanonicalKey,
				plan.targetCanonicalKey,
			]),
		),
	);
	const activeOverrides =
		overrideKeys.length > 0
			? await db
					.selectFrom("finance_ledger_entry_overrides")
					.select(["canonical_key"])
					.where("status", "=", "active")
					.where("canonical_key", "in", overrideKeys)
					.execute()
			: [];
	const activeOverrideKeys = new Set(
		activeOverrides.map((override) => override.canonical_key),
	);
	const targetCounts = new Map<string, number>();
	for (const plan of recoverablePlans) {
		targetCounts.set(
			plan.targetCanonicalKey,
			(targetCounts.get(plan.targetCanonicalKey) ?? 0) + 1,
		);
	}

	for (const plan of plans) {
		if (plan.status !== "recoverable") {
			continue;
		}
		const existingEntryId = existingByCanonicalKey.get(plan.targetCanonicalKey);
		if (existingEntryId && existingEntryId !== plan.id) {
			plan.status = "collision";
			plan.reason = "collision_existing_canonical_key";
			continue;
		}
		if ((targetCounts.get(plan.targetCanonicalKey) ?? 0) > 1) {
			plan.status = "collision";
			plan.reason = "collision_repaired_rows";
			continue;
		}
		if (
			plan.targetCanonicalKey !== plan.oldCanonicalKey &&
			activeOverrideKeys.has(plan.oldCanonicalKey) &&
			activeOverrideKeys.has(plan.targetCanonicalKey)
		) {
			plan.status = "collision";
			plan.reason = "collision_target_override";
		}
	}

	return {
		candidates: partialCandidates,
		plans,
	};
}

function summaryForOrg(orgId: string, plans: CandidatePlan[]) {
	return {
		orgId,
		candidates: plans.length,
		recoverable: plans.filter((plan) => plan.status === "recoverable").length,
		collisions: plans.filter((plan) => plan.status === "collision").length,
		skipped: plans.filter((plan) => plan.status !== "recoverable").length,
	};
}

async function backupOrgDatabase(input: { orgId: string; runLabel: string }) {
	const backupDir = resolve(
		dataRootDir(),
		"backups",
		`finance-ledger-date-repair-${input.runLabel}`,
	);
	mkdirSync(backupDir, { recursive: true });
	const backupPath = resolve(
		backupDir,
		`${input.orgId}-${isoTimestampLabel()}.sqlite`,
	);
	const quotedPath = backupPath.replace(/'/g, "''");
	getSqlite(input.orgId).exec(`VACUUM INTO '${quotedPath}'`);
	return backupPath;
}

async function writeManifest(input: {
	runLabel: string;
	orgId: string;
	mode: "dry-run" | "confirm";
	summary: ReturnType<typeof summaryForOrg>;
	plans: CandidatePlan[];
	backupPath: string | null;
}) {
	const manifestDir = resolve(
		dataRootDir(),
		"tmp",
		"migrations",
		`finance-ledger-date-repair-${input.runLabel}`,
	);
	mkdirSync(manifestDir, { recursive: true });
	const manifestPath = resolve(manifestDir, `${input.orgId}.json`);
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				orgId: input.orgId,
				mode: input.mode,
				summary: input.summary,
				backupPath: input.backupPath,
				plans: input.plans,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return manifestPath;
}

export function parseFinanceLedgerDateRepairArgs(
	argv = process.argv,
): ParsedArgs {
	const args = argv.slice(2);
	let allOrgs = false;
	let confirm = false;
	let dryRun = false;
	let orgId: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			continue;
		}
		switch (arg) {
			case "--all-orgs":
				allOrgs = true;
				break;
			case "--confirm":
				confirm = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--org": {
				const value = args[index + 1]?.trim();
				if (!value) {
					throw new Error("Missing value for --org");
				}
				orgId = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unsupported finance:repair-ledger-dates arg: ${arg}`);
		}
	}

	if (orgId && allOrgs) {
		throw new Error(
			"finance:repair-ledger-dates accepts either --org <orgId> or --all-orgs",
		);
	}
	if (!orgId && !allOrgs) {
		throw new Error(
			"finance:repair-ledger-dates requires --org <orgId> or --all-orgs",
		);
	}
	if (confirm === dryRun) {
		throw new Error(
			"finance:repair-ledger-dates requires exactly one of --dry-run or --confirm",
		);
	}

	return { allOrgs, confirm, dryRun, orgId };
}

function targetOrgIds(args: ParsedArgs) {
	return args.orgId ? [args.orgId] : defaultMigrationTargetOrgIds();
}

export async function repairFinanceLedgerDatesForOrg(input: {
	orgId: string;
	confirm: boolean;
	dryRun: boolean;
	runLabel?: string;
}) {
	const runLabel = input.runLabel ?? isoTimestampLabel();
	return runWithOrgContext(input.orgId, async () => {
		ensureStorageDirs();
		runMigrations(input.orgId);
		await ensureAccountOwnershipBackfill(input.orgId);

		const { plans } = await buildCandidatePlans(input.orgId);
		const summary = summaryForOrg(input.orgId, plans);
		const repairablePlans = plans.filter(
			(plan) => plan.status === "recoverable",
		);

		let backupPath: string | null = null;
		if (input.confirm) {
			backupPath = await backupOrgDatabase({
				orgId: input.orgId,
				runLabel,
			});

			const db = getDb(input.orgId);
			await db.transaction().execute(async (trx) => {
				for (const plan of repairablePlans) {
					const current = await trx
						.selectFrom("finance_ledger_entries")
						.select([
							"occurred_at",
							"cleared_at",
							"occurred_at_precision",
							"cleared_at_precision",
						])
						.where("id", "=", plan.id)
						.executeTakeFirstOrThrow();
					await trx
						.updateTable("finance_ledger_entries")
						.set({
							...(plan.targetCanonicalKey !== plan.oldCanonicalKey
								? { canonical_key: plan.targetCanonicalKey }
								: {}),
							posted_at: plan.postedAt,
							posted_at_precision: plan.postedAtPrecision,
							occurred_at_precision: precisionForLedgerDate(
								current.occurred_at,
							),
							cleared_at_precision: precisionForLedgerDate(current.cleared_at),
							ledger_metadata_json: plan.ledgerMetadataJson,
							updated_at: nowIso(),
						})
						.where("id", "=", plan.id)
						.execute();
					if (plan.targetCanonicalKey !== plan.oldCanonicalKey) {
						await trx
							.updateTable("finance_ledger_entry_overrides")
							.set({
								canonical_key: plan.targetCanonicalKey,
								updated_at: nowIso(),
							})
							.where("canonical_key", "=", plan.oldCanonicalKey)
							.execute();
					}
				}
			});
		}

		const manifestPath = await writeManifest({
			runLabel,
			orgId: input.orgId,
			mode: input.confirm ? "confirm" : "dry-run",
			summary,
			plans,
			backupPath,
		});

		return {
			...summary,
			updated: input.confirm ? repairablePlans.length : 0,
			backupPath,
			manifestPath,
			plans,
		};
	});
}

export async function main(_trace?: LogTrace, argv = process.argv) {
	const args = parseFinanceLedgerDateRepairArgs(argv);
	ensureStorageDirs();
	const runLabel = isoTimestampLabel();
	const results = [];

	for (const orgId of targetOrgIds(args)) {
		results.push(
			await repairFinanceLedgerDatesForOrg({
				orgId,
				confirm: args.confirm,
				dryRun: args.dryRun,
				runLabel,
			}),
		);
	}

	process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

runCli(main, import.meta.url, "finance:repair-ledger-dates");
