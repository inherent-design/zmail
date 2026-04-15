import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Generated } from "kysely";
import { Kysely, SqliteDialect } from "kysely";

import {
	DB_PATH,
	ensureStorageDirs,
	MIGRATIONS_DIR,
	nowIso,
} from "#/lib/config";

interface AccountsTable {
	id: string;
	label: string;
	email_address: string;
	provider_kind: string;
	sync_enabled: number;
	sync_status: string;
	source_truth: string;
	selected_mailbox: string;
	last_synced_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

interface AccountSyncStateTable {
	account_id: string;
	uidvalidity: number | null;
	latest_uid_cursor: number | null;
	earliest_uid_cursor: number | null;
	backfill_snapshot_uid: number | null;
	backfill_next_uid: number | null;
	last_bootstrap_started_at: string | null;
	last_bootstrap_completed_at: string | null;
	last_delta_sync_at: string | null;
	last_reconcile_at: string | null;
	last_backfill_sync_at: string | null;
	backfill_completed_at: string | null;
	last_idle_started_at: string | null;
	last_idle_heartbeat_at: string | null;
	watcher_status: string;
	consecutive_failures: number;
	backoff_until: string | null;
	created_at: string;
	updated_at: string;
}

interface MessagesTable {
	id: string;
	account_id: string;
	message_id: string;
	thread_key: string;
	received_at: string | null;
	ingested_at: string;
	conversation_id: string | null;
	sender_name: string | null;
	sender_address: string | null;
	to_json: string;
	cc_json: string;
	subject: string | null;
	in_reply_to: string | null;
	body_text_primary: string;
	body_text_forwarded: string;
	body_text_normalized: string;
	snippet: string;
	attachment_count: number;
	has_html: number;
	raw_byte_start: number;
	raw_byte_end: number;
	parse_status: string;
	body_extraction_strategy: string;
	parse_error_reason: string | null;
	token_estimate: number;
	content_sha256: string | null;
	created_at: string;
}

interface ConversationsTable {
	id: string;
	account_id: string;
	gmail_thread_id: string;
	first_message_received_at: string | null;
	last_message_received_at: string | null;
	message_count: number;
	created_at: string;
	updated_at: string;
}

interface AttachmentsTable {
	id: string;
	message_id: string;
	filename: string | null;
	mime_type: string | null;
	size_bytes: number;
	content_id: string | null;
	is_inline: number;
}

interface MessageSourcesTable {
	id: string;
	message_id: string;
	account_id: string;
	remote_message_id: string | null;
	remote_thread_id: string | null;
	mailbox: string | null;
	imap_uid: number | null;
	uidvalidity: number | null;
	raw_rfc822_path: string | null;
	raw_sha256: string | null;
	state: string;
	first_seen_at: string;
	last_seen_at: string;
	tombstoned_at: string | null;
	updated_at: string;
}

interface JobsTable {
	id: string;
	kind: string;
	scope_type: string;
	scope_id: string;
	status: string;
	model: string | null;
	prompt_version: string | null;
	request_count: number;
	success_count: number;
	error_count: number;
	claimed_at: string | null;
	lease_expires_at: string | null;
	attempts: number;
	last_error: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	meta_json: string;
}

interface ModerationResultsTable {
	id: string;
	job_id: string | null;
	message_id: string;
	model: string;
	categories_json: string;
	category_scores_json: string;
	raw_response_json: string;
	nsfw_flag: number;
	created_at: string;
}

interface ClassificationResultsTable {
	id: string;
	job_id: string | null;
	message_id: string;
	schema_version: Generated<string>;
	model: string;
	prompt_version: string;
	source: string;
	result_json: string;
	raw_response_json: string;
	usage_json: string | null;
	low_confidence: number;
	input_content_sha256: string | null;
	created_at: string;
}

interface MessageLabelsTable {
	message_id: string;
	classification_result_id: string;
	schema_version: Generated<string>;
	source: string;
	label_json: string;
	primary_bucket: string;
	low_confidence: number;
	nsfw: number;
	content_sha256: string | null;
	updated_at: string;
}

interface MessageSecondaryResultsTable {
	id: string;
	message_id: string;
	classifier_key: string;
	schema_version: string;
	job_id: string | null;
	model: string;
	prompt_version: string;
	source: string;
	result_json: string;
	raw_response_json: string;
	usage_json: string | null;
	input_content_sha256: string | null;
	input_registry_sha256: string | null;
	created_at: string;
}

interface MessageSecondaryHeadsTable {
	message_id: string;
	classifier_key: string;
	secondary_result_id: string | null;
	status: string;
	low_confidence: number;
	content_sha256: string | null;
	registry_sha256: string | null;
	updated_at: string;
}

interface RegistryIdentitiesTable {
	id: string;
	kind: string;
	source_kind: Generated<string>;
	display_name: string;
	aliases_json: string;
	email_addresses_json: string;
	domains_json: string;
	tax_owner_hint: string | null;
	notes: string | null;
}

interface RegistryInstitutionsTable {
	id: string;
	source_kind: Generated<string>;
	display_name: string;
	aliases_json: string;
	domains_json: string;
	notes: string | null;
}

interface RegistryFinancialAccountsTable {
	id: string;
	source_kind: Generated<string>;
	institution_id: string | null;
	owner_identity_id: string | null;
	display_name: string;
	aliases_json: string;
	account_mask: string | null;
	account_last4: string | null;
	account_type: string | null;
	currency: string | null;
	tax_owner_hint: string | null;
	notes: string | null;
}

interface RegistrySenderRulesTable {
	id: string;
	source_kind: Generated<string>;
	sender_pattern: string;
	domain: string | null;
	owner_identity_id: string | null;
	institution_id: string | null;
	financial_account_id: string | null;
	message_kind_hint: string | null;
	priority: number;
	notes: string | null;
}

interface RegistryImportStateTable {
	key: string;
	combined_sha256: string;
	source_dir: string;
	counts_json: string;
	imported_at: string;
}

interface FinanceEventCandidatesTable {
	id: string;
	canonical_key: string;
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

interface FinanceDocumentCandidatesTable {
	id: string;
	canonical_key: string;
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

interface FinanceEventEvidenceTable {
	id: string;
	event_candidate_id: string | null;
	document_candidate_id: string | null;
	message_id: string;
	secondary_result_id: string;
	transaction_index: number | null;
	document_index: number | null;
	evidence_json: string;
	created_at: string;
}

interface ReviewsTable {
	id: string;
	message_id: string;
	source_classification_result_id: string;
	status: string;
	reviewer_note: string | null;
	override_label_json: string | null;
	created_at: string;
	resolved_at: string | null;
}

interface OverseerProfilesTable {
	id: string;
	account_id: string;
	built_from_messages: number;
	promoted_tags_json: string;
	prompt_preamble: string;
	profile_json: string;
	created_at: string;
}

interface ClassificationRuleSetsTable {
	key: string;
	schema_version: string;
	source_path: string;
	sha256: string;
	payload_json: string;
	imported_at: string;
}

interface ClassificationRulesTable {
	id: string;
	rule_set_key: string;
	rule_key: string;
	priority: number;
	enabled: number;
	match_json: string;
	projection_json: string;
	created_at: string;
}

interface MessageCategoryAssignmentsTable {
	id: string;
	message_id: string;
	source: string;
	matched_rule_key: string | null;
	projected_primary_category: string;
	projected_secondary_category: string | null;
	projected_finance_primary: string | null;
	projected_finance_secondary: string | null;
	result_json: string;
	input_content_sha256: string | null;
	rule_set_sha256: string | null;
	finance_result_id: string | null;
	created_at: string;
}

interface MessageCategoryAssignmentHeadsTable {
	message_id: string;
	assignment_id: string;
	source: string;
	input_content_sha256: string | null;
	rule_set_sha256: string | null;
	finance_result_id: string | null;
	updated_at: string;
}

interface FinanceImportRunsTable {
	id: string;
	source_kind: string;
	source_file_path: string;
	source_file_sha256: string;
	filename: string;
	artifact_sha256: string;
	extractor_runner: string;
	extractor_model: string;
	extractor_prompt_version: string;
	extracted_text_hash: string | null;
	status: string;
	raw_artifact_json: string;
	imported_at: string;
}

interface FinanceImportDocumentsTable {
	id: string;
	import_run_id: string;
	source_document_ref: string | null;
	document_type: string;
	issuer: string | null;
	external_id: string | null;
	statement_period_start: string | null;
	statement_period_end: string | null;
	due_at: string | null;
	tax_year: number | null;
	owner_identity_hint: string | null;
	financial_account_hint: string | null;
	institution_hint: string | null;
	evidence_text: string;
	payload_json: string;
	created_at: string;
}

interface FinanceImportTransactionsTable {
	id: string;
	import_run_id: string;
	source_document_ref: string | null;
	occurred_at: string | null;
	posted_at: string | null;
	amount_value: string | null;
	amount_minor: number | null;
	currency: string | null;
	direction: string;
	description: string | null;
	merchant_or_counterparty: string | null;
	balance_value: string | null;
	owner_identity_hint: string | null;
	financial_account_hint: string | null;
	institution_hint: string | null;
	category_primary: string | null;
	category_secondary: string | null;
	evidence_text: string;
	payload_json: string;
	created_at: string;
}

interface RegistrySuggestionsTable {
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
}

interface FinanceYearlyRollupsTable {
	id: string;
	year: number;
	source_kind: string;
	primary_category: string;
	inflow_minor: number;
	outflow_minor: number;
	net_minor: number;
	transaction_count: number;
	imported_statement_count: number;
	extracted_transaction_count: number;
	uncategorized_count: number;
	created_at: string;
	updated_at: string;
}

interface FinanceYearlySubcategoryRollupsTable {
	id: string;
	year: number;
	source_kind: string;
	primary_category: string;
	secondary_category: string;
	inflow_minor: number;
	outflow_minor: number;
	net_minor: number;
	transaction_count: number;
	created_at: string;
	updated_at: string;
}

export interface DB {
	accounts: AccountsTable;
	account_sync_state: AccountSyncStateTable;
	conversations: ConversationsTable;
	messages: MessagesTable;
	attachments: AttachmentsTable;
	message_sources: MessageSourcesTable;
	jobs: JobsTable;
	moderation_results: ModerationResultsTable;
	classification_results: ClassificationResultsTable;
	message_labels: MessageLabelsTable;
	message_secondary_results: MessageSecondaryResultsTable;
	message_secondary_heads: MessageSecondaryHeadsTable;
	registry_identities: RegistryIdentitiesTable;
	registry_institutions: RegistryInstitutionsTable;
	registry_financial_accounts: RegistryFinancialAccountsTable;
	registry_sender_rules: RegistrySenderRulesTable;
	registry_import_state: RegistryImportStateTable;
	finance_event_candidates: FinanceEventCandidatesTable;
	finance_document_candidates: FinanceDocumentCandidatesTable;
	finance_event_evidence: FinanceEventEvidenceTable;
	reviews: ReviewsTable;
	overseer_profiles: OverseerProfilesTable;
	classification_rule_sets: ClassificationRuleSetsTable;
	classification_rules: ClassificationRulesTable;
	message_category_assignments: MessageCategoryAssignmentsTable;
	message_category_assignment_heads: MessageCategoryAssignmentHeadsTable;
	finance_import_runs: FinanceImportRunsTable;
	finance_import_documents: FinanceImportDocumentsTable;
	finance_import_transactions: FinanceImportTransactionsTable;
	registry_suggestions: RegistrySuggestionsTable;
	finance_yearly_rollups: FinanceYearlyRollupsTable;
	finance_yearly_subcategory_rollups: FinanceYearlySubcategoryRollupsTable;
}

const REQUIRED_BASELINE_TABLES = [
	"accounts",
	"account_sync_state",
	"conversations",
	"messages",
	"attachments",
	"message_sources",
	"moderation_results",
	"classification_results",
	"message_labels",
	"reviews",
	"jobs",
	"message_secondary_results",
	"message_secondary_heads",
	"registry_identities",
	"registry_institutions",
	"registry_financial_accounts",
	"registry_sender_rules",
	"registry_import_state",
	"finance_event_candidates",
	"finance_document_candidates",
	"finance_event_evidence",
	"classification_rule_sets",
	"classification_rules",
	"message_category_assignments",
	"message_category_assignment_heads",
	"finance_import_runs",
	"finance_import_documents",
	"finance_import_transactions",
	"registry_suggestions",
	"finance_yearly_rollups",
	"finance_yearly_subcategory_rollups",
] as const;

const REQUIRED_EXISTING_BASELINE_TABLES = [
	"accounts",
	"account_sync_state",
	"messages",
	"attachments",
	"message_sources",
	"moderation_results",
	"classification_results",
	"message_labels",
	"reviews",
	"jobs",
] as const;

const REQUIRED_MESSAGE_COLUMNS = [
	"ingested_at",
	"conversation_id",
	"body_text_primary",
	"body_text_forwarded",
	"body_extraction_strategy",
	"parse_error_reason",
] as const;

export function buildSchemaResetRequiredMessage(input?: {
	missingTables?: string[];
	missingMessageColumns?: string[];
}) {
	const details = [
		...(input?.missingTables?.length
			? [`Missing tables: ${input.missingTables.join(", ")}`]
			: []),
		...(input?.missingMessageColumns?.length
			? [`Missing messages columns: ${input.missingMessageColumns.join(", ")}`]
			: []),
	];
	const detailBlock = details.length > 0 ? `\n\n${details.join("\n")}` : "";

	return `This local database predates the rewritten zmail baseline and must be reset before continuing.

Preferred recovery:
1. pnpm db:reset:messages

Full reset:
1. pnpm db:reset
2. pnpm db:migrate
3. reconnect Gmail accounts if you used the full reset${detailBlock}`;
}

export class SchemaResetRequiredError extends Error {
	readonly code = "SCHEMA_RESET_REQUIRED";
	readonly missingTables: string[];
	readonly missingMessageColumns: string[];

	constructor(input: {
		missingTables: string[];
		missingMessageColumns: string[];
	}) {
		super(buildSchemaResetRequiredMessage(input));
		this.name = "SchemaResetRequiredError";
		this.missingTables = input.missingTables;
		this.missingMessageColumns = input.missingMessageColumns;
	}
}

declare global {
	var __zmailSqlite__: Database.Database | undefined;
	var __zmailDb__: Kysely<DB> | undefined;
}

export function getSqlite() {
	if (globalThis.__zmailSqlite__) {
		return globalThis.__zmailSqlite__;
	}

	ensureStorageDirs();
	mkdirSync(dirname(DB_PATH), { recursive: true });

	const sqlite = new Database(DB_PATH);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.pragma("busy_timeout = 5000");

	globalThis.__zmailSqlite__ = sqlite;
	return sqlite;
}

export function getDb() {
	if (globalThis.__zmailDb__) {
		return globalThis.__zmailDb__;
	}

	const db = new Kysely<DB>({
		dialect: new SqliteDialect({
			database: getSqlite(),
		}),
	});

	globalThis.__zmailDb__ = db;
	return db;
}

export async function resetDb() {
	if (globalThis.__zmailDb__) {
		await globalThis.__zmailDb__.destroy();
		globalThis.__zmailDb__ = undefined;
	}

	if (globalThis.__zmailSqlite__) {
		globalThis.__zmailSqlite__.close();
		globalThis.__zmailSqlite__ = undefined;
	}
}

export function runMigrations() {
	const sqlite = getSqlite();
	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((entry) => entry.endsWith(".sql"))
		.sort();

	const applied = new Set(
		sqlite
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
	const insertMigration = sqlite.prepare(
		"INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
	);
	const currentTables = new Set(
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
	const currentMessageColumns = new Set(
		sqlite
			.prepare("PRAGMA table_info(messages)")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
	if (applied.has("001_init.sql")) {
		const missingExistingTables = REQUIRED_EXISTING_BASELINE_TABLES.filter(
			(tableName) => !currentTables.has(tableName),
		);
		const missingExistingMessageColumns = REQUIRED_MESSAGE_COLUMNS.filter(
			(columnName) => !currentMessageColumns.has(columnName),
		);
		if (
			missingExistingTables.length > 0 ||
			missingExistingMessageColumns.length > 0
		) {
			throw new SchemaResetRequiredError({
				missingTables: [...missingExistingTables],
				missingMessageColumns: [...missingExistingMessageColumns],
			});
		}
	}

	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}
		const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
		sqlite.exec(sql);
		insertMigration.run(file, nowIso());
		applied.add(file);
	}

	assertBaselineSchemaCompatibility(sqlite);
}

export function assertBaselineSchemaCompatibility(sqlite = getSqlite()) {
	const tables = new Set(
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
	const missingTables = REQUIRED_BASELINE_TABLES.filter(
		(tableName) => !tables.has(tableName),
	);
	const messageColumns = new Set(
		sqlite
			.prepare("PRAGMA table_info(messages)")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
	const missingMessageColumns = REQUIRED_MESSAGE_COLUMNS.filter(
		(columnName) => !messageColumns.has(columnName),
	);

	if (missingTables.length > 0 || missingMessageColumns.length > 0) {
		throw new SchemaResetRequiredError({
			missingTables: [...missingTables],
			missingMessageColumns: [...missingMessageColumns],
		});
	}
}

export function safeJsonParse<T>(value: string | null, fallback: T): T {
	if (!value) {
		return fallback;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function jsonText(value: unknown) {
	return JSON.stringify(value);
}

export function fileName(path: string) {
	return basename(path);
}
