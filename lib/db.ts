import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Generated } from "kysely";
import { Kysely, SqliteDialect } from "kysely";

import { loadResolvedConfig } from "#/lib/app-config";
import {
	dbPath,
	ensureStorageDirs,
	MIGRATIONS_DIR,
	nowIso,
} from "#/lib/config";
import { currentOrgId, defaultOrgId, orgsRootDir } from "#/lib/runtime";

interface AccountsTable {
	id: string;
	label: string;
	email_address: string;
	owner_principal_email: string | null;
	provider_kind: string;
	sync_enabled: number;
	sync_status: string;
	connection_state: Generated<string>;
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
	lane: Generated<string>;
	priority: Generated<number>;
	run_after_at: Generated<string | null>;
	claim_owner: Generated<string | null>;
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
	prompt_sha256: string | null;
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
	prompt_sha256: string | null;
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

interface ReviewClassificationResultsTable {
	id: string;
	job_id: string | null;
	schema_version: string;
	model: string;
	prompt_version: string;
	prompt_sha256: string | null;
	source: string;
	input_summary_json: string;
	result_json: string;
	raw_response_json: string;
	usage_json: string | null;
	created_at: string;
}

interface ReviewClassificationHeadsTable {
	target_kind: string;
	target_id: string;
	result_id: string;
	severity: string;
	action: string;
	status: string;
	confidence: number;
	reason: string;
	evidence_refs_json: string;
	updated_at: string;
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
	statement_opening_balance: Generated<string | null>;
	statement_closing_balance: Generated<string | null>;
	statement_transaction_count: Generated<number | null>;
	statement_currency: Generated<string | null>;
	account_mapping_key: Generated<string | null>;
	extraction_confidence: Generated<number>;
	raw_document_payload_json: Generated<string>;
	raw_payload_json: Generated<string>;
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
	external_transaction_id: Generated<string | null>;
	cleared_at: Generated<string | null>;
	statement_row_id: Generated<string | null>;
	row_index: Generated<number | null>;
	account_mapping_key: Generated<string | null>;
	book_hint: Generated<string>;
	business_use_percent: Generated<number | null>;
	extraction_confidence: Generated<number>;
	raw_row_payload_json: Generated<string>;
	row_provenance_json: Generated<string>;
	raw_payload_json: Generated<string>;
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

interface FinanceLedgerEntriesTable {
	id: string;
	canonical_key: string;
	status: string;
	source_authority: string;
	occurred_at: string | null;
	posted_at: string | null;
	cleared_at: string | null;
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

interface FinanceLedgerEntrySourcesTable {
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

interface FinancePatternsTable {
	id: string;
	pattern_kind: string;
	pattern_key: string;
	status: string;
	confidence: number;
	summary_json: string;
	first_seen_at: string | null;
	last_seen_at: string | null;
	created_at: string;
	updated_at: string;
}

interface FinanceExportRunsTable {
	id: string;
	status: string;
	strict: number;
	year: number | null;
	out_dir: string;
	package_json: string;
	validation_json: string;
	created_at: string;
	completed_at: string | null;
}

interface FinanceExportItemsTable {
	id: string;
	export_run_id: string;
	ledger_entry_id: string | null;
	canonical_key: string;
	status: string;
	beancount_link: string | null;
	sidecar_reason: string | null;
	payload_json: string;
	created_at: string;
}

interface TaxReportRunsTable {
	id: string;
	status: string;
	report_kind: string;
	year: number;
	quarter: number | null;
	business_slug: string | null;
	out_dir: string;
	manifest_json: string;
	validation_json: string;
	created_at: string;
	completed_at: string | null;
}

interface FinanceAccountMappingsTable {
	id: string;
	mapping_key: string;
	book: string;
	account_name: string;
	account_type: string;
	currency: string | null;
	confidence: number;
	source_json: string;
	debit_account: Generated<string | null>;
	credit_account: Generated<string | null>;
	match_json: Generated<string>;
	notes: Generated<string | null>;
	source_path: Generated<string | null>;
	created_at: string;
	updated_at: string;
}

interface FinanceModelMigrationRunsTable {
	id: string;
	org_id: string;
	status: string;
	archived_at: string;
	completed_at: string | null;
	cleaned_at: string | null;
	options_json: string;
	counts_json: string;
}

interface FinanceV3ArchiveRowsTable {
	id: string;
	archive_run_id: string;
	org_id: string;
	source_table: string;
	source_pk: string | null;
	payload_json: string;
	archived_at: string;
}

interface FinanceV3CleanGuardTable {
	id: string;
	note: string;
	created_at: string;
}

interface RuntimeEventsTable {
	id: Generated<number>;
	topic: string;
	event_type: string;
	entity_kind: string | null;
	entity_id: string | null;
	payload_json: string;
	created_at: string;
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
	review_classification_results: ReviewClassificationResultsTable;
	review_classification_heads: ReviewClassificationHeadsTable;
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
	finance_ledger_entries: FinanceLedgerEntriesTable;
	finance_ledger_entry_sources: FinanceLedgerEntrySourcesTable;
	finance_patterns: FinancePatternsTable;
	finance_export_runs: FinanceExportRunsTable;
	finance_export_items: FinanceExportItemsTable;
	tax_report_runs: TaxReportRunsTable;
	finance_account_mappings: FinanceAccountMappingsTable;
	finance_model_migration_runs: FinanceModelMigrationRunsTable;
	finance_v3_archive_rows: FinanceV3ArchiveRowsTable;
	finance_v3_clean_guard: FinanceV3CleanGuardTable;
	runtime_events: RuntimeEventsTable;
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
	"review_classification_results",
	"review_classification_heads",
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
	"finance_ledger_entries",
	"finance_ledger_entry_sources",
	"finance_patterns",
	"finance_export_runs",
	"finance_export_items",
	"tax_report_runs",
	"finance_account_mappings",
	"finance_model_migration_runs",
	"finance_v3_archive_rows",
	"finance_v3_clean_guard",
	"runtime_events",
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

const REQUIRED_CANONICAL_COLUMNS = {
	accounts: ["owner_principal_email", "connection_state"],
	jobs: ["lane", "priority", "run_after_at", "claim_owner"],
	classification_results: ["schema_version", "prompt_sha256"],
	message_labels: ["schema_version"],
	message_secondary_results: ["prompt_sha256"],
	registry_identities: ["source_kind"],
	registry_institutions: ["source_kind"],
	registry_financial_accounts: ["source_kind"],
	registry_sender_rules: ["source_kind"],
	finance_import_documents: [
		"statement_opening_balance",
		"statement_closing_balance",
		"statement_transaction_count",
		"statement_currency",
		"account_mapping_key",
		"extraction_confidence",
		"raw_document_payload_json",
		"raw_payload_json",
	],
	finance_import_transactions: [
		"external_transaction_id",
		"cleared_at",
		"statement_row_id",
		"row_index",
		"account_mapping_key",
		"book_hint",
		"business_use_percent",
		"extraction_confidence",
		"raw_row_payload_json",
		"row_provenance_json",
		"raw_payload_json",
	],
	finance_account_mappings: [
		"debit_account",
		"credit_account",
		"match_json",
		"notes",
		"source_path",
	],
} as const;

const ADOPTABLE_CANONICAL_COLUMNS = {
	"accounts.owner_principal_email":
		"ALTER TABLE accounts ADD COLUMN owner_principal_email TEXT;",
	"accounts.connection_state": `ALTER TABLE accounts ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'connected'
  CHECK (connection_state IN ('connected', 'config_error', 'paused', 'needs_reconnect', 'disconnected'));`,
	"jobs.lane":
		"ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'materialize';",
	"jobs.priority":
		"ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;",
	"jobs.run_after_at": "ALTER TABLE jobs ADD COLUMN run_after_at TEXT;",
	"jobs.claim_owner": "ALTER TABLE jobs ADD COLUMN claim_owner TEXT;",
	"classification_results.schema_version":
		"ALTER TABLE classification_results ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'message-label.v1';",
	"classification_results.prompt_sha256":
		"ALTER TABLE classification_results ADD COLUMN prompt_sha256 TEXT;",
	"message_labels.schema_version":
		"ALTER TABLE message_labels ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'message-label.v1';",
	"message_secondary_results.prompt_sha256":
		"ALTER TABLE message_secondary_results ADD COLUMN prompt_sha256 TEXT;",
	"registry_identities.source_kind":
		"ALTER TABLE registry_identities ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';",
	"registry_institutions.source_kind":
		"ALTER TABLE registry_institutions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';",
	"registry_financial_accounts.source_kind":
		"ALTER TABLE registry_financial_accounts ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';",
	"registry_sender_rules.source_kind":
		"ALTER TABLE registry_sender_rules ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';",
	"finance_import_documents.statement_opening_balance":
		"ALTER TABLE finance_import_documents ADD COLUMN statement_opening_balance TEXT;",
	"finance_import_documents.statement_closing_balance":
		"ALTER TABLE finance_import_documents ADD COLUMN statement_closing_balance TEXT;",
	"finance_import_documents.statement_transaction_count":
		"ALTER TABLE finance_import_documents ADD COLUMN statement_transaction_count INTEGER;",
	"finance_import_documents.statement_currency":
		"ALTER TABLE finance_import_documents ADD COLUMN statement_currency TEXT;",
	"finance_import_documents.account_mapping_key":
		"ALTER TABLE finance_import_documents ADD COLUMN account_mapping_key TEXT;",
	"finance_import_documents.extraction_confidence":
		"ALTER TABLE finance_import_documents ADD COLUMN extraction_confidence REAL NOT NULL DEFAULT 0;",
	"finance_import_documents.raw_document_payload_json":
		"ALTER TABLE finance_import_documents ADD COLUMN raw_document_payload_json TEXT NOT NULL DEFAULT '{}';",
	"finance_import_documents.raw_payload_json":
		"ALTER TABLE finance_import_documents ADD COLUMN raw_payload_json TEXT NOT NULL DEFAULT '{}';",
	"finance_import_transactions.external_transaction_id":
		"ALTER TABLE finance_import_transactions ADD COLUMN external_transaction_id TEXT;",
	"finance_import_transactions.cleared_at":
		"ALTER TABLE finance_import_transactions ADD COLUMN cleared_at TEXT;",
	"finance_import_transactions.statement_row_id":
		"ALTER TABLE finance_import_transactions ADD COLUMN statement_row_id TEXT;",
	"finance_import_transactions.row_index":
		"ALTER TABLE finance_import_transactions ADD COLUMN row_index INTEGER;",
	"finance_import_transactions.account_mapping_key":
		"ALTER TABLE finance_import_transactions ADD COLUMN account_mapping_key TEXT;",
	"finance_import_transactions.book_hint":
		"ALTER TABLE finance_import_transactions ADD COLUMN book_hint TEXT NOT NULL DEFAULT 'unknown';",
	"finance_import_transactions.business_use_percent":
		"ALTER TABLE finance_import_transactions ADD COLUMN business_use_percent REAL;",
	"finance_import_transactions.extraction_confidence":
		"ALTER TABLE finance_import_transactions ADD COLUMN extraction_confidence REAL NOT NULL DEFAULT 0;",
	"finance_import_transactions.raw_row_payload_json":
		"ALTER TABLE finance_import_transactions ADD COLUMN raw_row_payload_json TEXT NOT NULL DEFAULT '{}';",
	"finance_import_transactions.row_provenance_json":
		"ALTER TABLE finance_import_transactions ADD COLUMN row_provenance_json TEXT NOT NULL DEFAULT '{}';",
	"finance_import_transactions.raw_payload_json":
		"ALTER TABLE finance_import_transactions ADD COLUMN raw_payload_json TEXT NOT NULL DEFAULT '{}';",
	"finance_account_mappings.debit_account":
		"ALTER TABLE finance_account_mappings ADD COLUMN debit_account TEXT;",
	"finance_account_mappings.credit_account":
		"ALTER TABLE finance_account_mappings ADD COLUMN credit_account TEXT;",
	"finance_account_mappings.match_json":
		"ALTER TABLE finance_account_mappings ADD COLUMN match_json TEXT NOT NULL DEFAULT '{}';",
	"finance_account_mappings.notes":
		"ALTER TABLE finance_account_mappings ADD COLUMN notes TEXT;",
	"finance_account_mappings.source_path":
		"ALTER TABLE finance_account_mappings ADD COLUMN source_path TEXT;",
} as const;

type CanonicalColumnRef = keyof typeof ADOPTABLE_CANONICAL_COLUMNS;
type SchemaCompatibilityDetails = {
	missingTables: string[];
	missingMessageColumns: string[];
	missingColumns: string[];
	staleAppliedMigrations: string[];
};

export function buildSchemaResetRequiredMessage(input?: {
	missingTables?: string[];
	missingMessageColumns?: string[];
	missingColumns?: string[];
}) {
	const details = [
		...(input?.missingTables?.length
			? [`Missing tables: ${input.missingTables.join(", ")}`]
			: []),
		...(input?.missingMessageColumns?.length
			? [`Missing messages columns: ${input.missingMessageColumns.join(", ")}`]
			: []),
		...(input?.missingColumns?.length
			? [`Missing columns: ${input.missingColumns.join(", ")}`]
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
	readonly missingColumns: string[];

	constructor(input: {
		missingTables: string[];
		missingMessageColumns: string[];
		missingColumns?: string[];
	}) {
		super(buildSchemaResetRequiredMessage(input));
		this.name = "SchemaResetRequiredError";
		this.missingTables = input.missingTables;
		this.missingMessageColumns = input.missingMessageColumns;
		this.missingColumns = input.missingColumns ?? [];
	}
}

export function buildSchemaAdoptionRequiredMessage(input?: {
	orgId?: string;
	missingColumns?: string[];
	staleAppliedMigrations?: string[];
}) {
	const orgId = input?.orgId ?? currentOrgId();
	const details = [
		...(input?.missingColumns?.length
			? [`Missing columns: ${input.missingColumns.join(", ")}`]
			: []),
		...(input?.staleAppliedMigrations?.length
			? [`Stale applied migrations: ${input.staleAppliedMigrations.join(", ")}`]
			: []),
	];
	const detailBlock = details.length > 0 ? `\n\n${details.join("\n")}` : "";

	return `This local database still uses pre-cleanup zmail migration history and must be adopted before continuing.

Required recovery:
1. pnpm db:migrate -- --all-orgs --adopt-history

Single-org recovery:
1. pnpm db:migrate -- --org ${orgId} --adopt-history${detailBlock}`;
}

export class SchemaAdoptionRequiredError extends Error {
	readonly code = "SCHEMA_ADOPTION_REQUIRED";
	readonly orgId: string;
	readonly missingColumns: string[];
	readonly staleAppliedMigrations: string[];

	constructor(input: {
		orgId?: string;
		missingColumns: string[];
		staleAppliedMigrations: string[];
	}) {
		const orgId = input.orgId ?? currentOrgId();
		super(buildSchemaAdoptionRequiredMessage({ ...input, orgId }));
		this.name = "SchemaAdoptionRequiredError";
		this.orgId = orgId;
		this.missingColumns = input.missingColumns;
		this.staleAppliedMigrations = input.staleAppliedMigrations;
	}
}

declare global {
	var __zmailSqliteMap__: Map<string, Database.Database> | undefined;
	var __zmailDbMap__: Map<string, Kysely<DB>> | undefined;
}

function sqliteMap() {
	if (!globalThis.__zmailSqliteMap__) {
		globalThis.__zmailSqliteMap__ = new Map();
	}
	return globalThis.__zmailSqliteMap__;
}

function dbMap() {
	if (!globalThis.__zmailDbMap__) {
		globalThis.__zmailDbMap__ = new Map();
	}
	return globalThis.__zmailDbMap__;
}

function ensureMigrationsTable(sqlite: Database.Database) {
	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function migrationFileNames() {
	return readdirSync(MIGRATIONS_DIR)
		.filter((entry) => entry.endsWith(".sql"))
		.sort();
}

function appliedMigrationNames(sqlite: Database.Database) {
	ensureMigrationsTable(sqlite);
	return sqlite
		.prepare("SELECT name FROM _migrations ORDER BY name")
		.all()
		.map((row) => String((row as { name: string }).name));
}

function tableNames(sqlite: Database.Database) {
	return new Set(
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
}

function tableColumnNames(sqlite: Database.Database, tableName: string) {
	return new Set(
		sqlite
			.prepare(`PRAGMA table_info(${tableName})`)
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
}

function addColumnIfMissing(
	sqlite: Database.Database,
	tableName: string,
	columnName: string,
	statement: string,
) {
	if (tableColumnNames(sqlite, tableName).has(columnName)) {
		return false;
	}
	sqlite.exec(statement);
	return true;
}

function applyCanonicalBaselineDdl(sqlite: Database.Database) {
	const sql = readFileSync(resolve(MIGRATIONS_DIR, "001_init.sql"), "utf8");
	sqlite.exec(sql);
}

function restampCanonicalMigrationHistory(
	sqlite: Database.Database,
	activeMigrationFiles: string[],
) {
	const restamp = sqlite.transaction((files: string[]) => {
		sqlite.prepare("DELETE FROM _migrations").run();
		const insertMigration = sqlite.prepare(
			"INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
		);
		for (const file of files) {
			insertMigration.run(file, nowIso());
		}
	});
	restamp(activeMigrationFiles);
}

function backfillConnectionState(sqlite: Database.Database) {
	sqlite.exec(`
		UPDATE accounts
		  SET connection_state = 'config_error'
		  WHERE last_error LIKE 'Google OAuth client credentials were rejected by Google.%';

		UPDATE accounts
		  SET connection_state = 'needs_reconnect'
		  WHERE sync_status = 'needs_reconnect'
		    AND connection_state = 'connected';

		UPDATE accounts
		  SET connection_state = 'paused'
		  WHERE (sync_status = 'paused' OR sync_enabled = 0)
		    AND connection_state = 'connected';
	`);
}

function buildSchemaCompatibilityDetails(
	sqlite: Database.Database,
	input?: {
		appliedMigrations?: string[];
		activeMigrationFiles?: string[];
	},
): SchemaCompatibilityDetails {
	const tables = tableNames(sqlite);
	const missingTables = REQUIRED_BASELINE_TABLES.filter(
		(tableName) => !tables.has(tableName),
	);
	const messageColumns = tableColumnNames(sqlite, "messages");
	const missingMessageColumns = REQUIRED_MESSAGE_COLUMNS.filter(
		(columnName) => !messageColumns.has(columnName),
	);
	const missingColumns = Object.entries(REQUIRED_CANONICAL_COLUMNS).flatMap(
		([tableName, requiredColumns]) => {
			const columns = tableColumnNames(sqlite, tableName);
			return requiredColumns
				.filter((columnName) => !columns.has(columnName))
				.map((columnName) => `${tableName}.${columnName}`);
		},
	);
	const activeFiles = input?.activeMigrationFiles ?? migrationFileNames();
	const staleAppliedMigrations = (
		input?.appliedMigrations ?? appliedMigrationNames(sqlite)
	).filter((name) => !activeFiles.includes(name));

	return {
		missingTables: [...missingTables],
		missingMessageColumns: [...missingMessageColumns],
		missingColumns,
		staleAppliedMigrations,
	};
}

function assertExistingLegacyBaselineCompatibility(sqlite: Database.Database) {
	const currentTables = tableNames(sqlite);
	const currentMessageColumns = tableColumnNames(sqlite, "messages");
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

function canAdoptCanonicalHistory(details: SchemaCompatibilityDetails) {
	if (details.missingMessageColumns.length > 0) {
		return false;
	}
	return canAdoptCanonicalColumns(details.missingColumns);
}

function canAdoptCanonicalColumns(missingColumns: string[]) {
	return missingColumns.every(
		(columnName): columnName is CanonicalColumnRef =>
			columnName in ADOPTABLE_CANONICAL_COLUMNS,
	);
}

function missingColumnsForExistingTables(
	sqlite: Database.Database,
	missingColumns: string[],
) {
	const tables = tableNames(sqlite);
	return missingColumns.filter((columnName) => {
		const [tableName] = columnName.split(".");
		return Boolean(tableName && tables.has(tableName));
	});
}

export function getSqlite(orgId = currentOrgId()) {
	const path = dbPath(orgId);
	const existing = sqliteMap().get(path);
	if (existing) {
		return existing;
	}
	ensureStorageDirs();
	mkdirSync(dirname(path), { recursive: true });

	const sqlite = new Database(path);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.pragma("busy_timeout = 5000");

	sqliteMap().set(path, sqlite);
	return sqlite;
}

export function getDb(orgId = currentOrgId()) {
	const path = dbPath(orgId);
	const existing = dbMap().get(path);
	if (existing) {
		return existing;
	}

	const db = new Kysely<DB>({
		dialect: new SqliteDialect({
			database: getSqlite(orgId),
		}),
	});

	dbMap().set(path, db);
	return db;
}

export async function resetDb(orgId?: string) {
	const paths = orgId ? [dbPath(orgId)] : [...dbMap().keys()];
	for (const path of paths) {
		const db = dbMap().get(path);
		if (db) {
			await db.destroy();
			dbMap().delete(path);
		}
	}

	const sqlitePaths = orgId ? [dbPath(orgId)] : [...sqliteMap().keys()];
	for (const path of sqlitePaths) {
		const sqlite = sqliteMap().get(path);
		if (sqlite) {
			sqlite.close();
			sqliteMap().delete(path);
		}
	}
}

export function runMigrations(orgId = currentOrgId()) {
	const sqlite = getSqlite(orgId);
	ensureMigrationsTable(sqlite);

	const files = migrationFileNames();
	const applied = new Set(appliedMigrationNames(sqlite));
	const insertMigration = sqlite.prepare(
		"INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
	);
	if (applied.has("001_init.sql")) {
		assertExistingLegacyBaselineCompatibility(sqlite);
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

	assertBaselineSchemaCompatibility(sqlite, {
		orgId,
		appliedMigrations: [...applied].sort(),
		activeMigrationFiles: files,
	});
}

export function assertBaselineSchemaCompatibility(
	sqlite = getSqlite(),
	input?: {
		orgId?: string;
		appliedMigrations?: string[];
		activeMigrationFiles?: string[];
	},
) {
	const details = buildSchemaCompatibilityDetails(sqlite, input);
	const hasCanonicalGaps =
		details.missingTables.length > 0 ||
		details.missingMessageColumns.length > 0 ||
		details.missingColumns.length > 0;
	if (!hasCanonicalGaps && details.staleAppliedMigrations.length === 0) {
		return;
	}

	if (
		details.staleAppliedMigrations.length > 0 &&
		canAdoptCanonicalHistory(details) &&
		details.missingColumns.length === 0
	) {
		throw new SchemaAdoptionRequiredError({
			orgId: input?.orgId,
			missingColumns: [],
			staleAppliedMigrations: details.staleAppliedMigrations,
		});
	}

	if (canAdoptCanonicalHistory(details)) {
		throw new SchemaAdoptionRequiredError({
			orgId: input?.orgId,
			missingColumns: details.missingColumns,
			staleAppliedMigrations: details.staleAppliedMigrations,
		});
	}

	if (
		details.staleAppliedMigrations.length > 0 &&
		details.missingTables.length === 0 &&
		details.missingMessageColumns.length === 0
	) {
		throw new SchemaResetRequiredError({
			missingTables: [],
			missingMessageColumns: [],
			missingColumns: details.missingColumns,
		});
	}

	if (
		details.missingTables.length > 0 ||
		details.missingMessageColumns.length > 0 ||
		details.missingColumns.length > 0
	) {
		throw new SchemaResetRequiredError({
			missingTables: details.missingTables,
			missingMessageColumns: details.missingMessageColumns,
			missingColumns: details.missingColumns,
		});
	}
}

export function discoverOrgIdsWithDatabases() {
	const root = orgsRootDir();
	if (!existsSync(root)) {
		return [] as string[];
	}
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((orgId) => existsSync(resolve(root, orgId, "zmail.sqlite")))
		.sort();
}

function addMissingAdoptableCanonicalColumns(
	sqlite: Database.Database,
	missingColumns: string[],
) {
	for (const columnName of missingColumns) {
		const statement =
			ADOPTABLE_CANONICAL_COLUMNS[
				columnName as keyof typeof ADOPTABLE_CANONICAL_COLUMNS
			];
		if (!statement) {
			throw new Error(`Unsupported canonical adoption column: ${columnName}`);
		}
		const [tableName, rawColumnName] = columnName.split(".");
		if (!tableName || !rawColumnName) {
			throw new Error(`Invalid canonical adoption column: ${columnName}`);
		}
		const added = addColumnIfMissing(
			sqlite,
			tableName,
			rawColumnName,
			statement,
		);
		if (added && columnName === "accounts.connection_state") {
			backfillConnectionState(sqlite);
		}
	}
}

export async function ensureAccountOwnershipBackfill(orgId = currentOrgId()) {
	const sqlite = getSqlite(orgId);
	const hasAccountsTable = tableNames(sqlite).has("accounts");
	if (!hasAccountsTable) {
		return;
	}

	const accountColumns = tableColumnNames(sqlite, "accounts");
	if (!accountColumns.has("owner_principal_email")) {
		return;
	}

	const db = getDb(orgId);
	const accounts = await db
		.selectFrom("accounts")
		.select(["id", "owner_principal_email"])
		.execute();
	const ownerlessAccountIds = accounts
		.filter((account) => !account.owner_principal_email?.trim())
		.map((account) => account.id);
	if (ownerlessAccountIds.length === 0) {
		return;
	}

	const bootstrapAdminEmail =
		loadResolvedConfig().auth.workos.bootstrapAdminEmails[0];
	if (!bootstrapAdminEmail) {
		throw new Error(
			"Account ownership backfill requires auth.workos.bootstrap_admin_emails when existing accounts have no owner.",
		);
	}

	await db
		.updateTable("accounts")
		.set({
			owner_principal_email: bootstrapAdminEmail,
		})
		.where("id", "in", ownerlessAccountIds)
		.execute();
}

export async function adoptCanonicalMigrationHistory(orgId = currentOrgId()) {
	const sqlite = getSqlite(orgId);
	ensureMigrationsTable(sqlite);
	const activeMigrationFiles = migrationFileNames();
	const appliedMigrations = appliedMigrationNames(sqlite);
	if (appliedMigrations.includes("001_init.sql")) {
		assertExistingLegacyBaselineCompatibility(sqlite);
	}

	let details = buildSchemaCompatibilityDetails(sqlite, {
		appliedMigrations,
		activeMigrationFiles,
	});
	if (details.missingMessageColumns.length > 0) {
		throw new SchemaResetRequiredError({
			missingTables: details.missingTables,
			missingMessageColumns: details.missingMessageColumns,
			missingColumns: details.missingColumns,
		});
	}

	const missingExistingColumns = missingColumnsForExistingTables(
		sqlite,
		details.missingColumns,
	);
	if (!canAdoptCanonicalColumns(missingExistingColumns)) {
		throw new SchemaResetRequiredError({
			missingTables: details.missingTables,
			missingMessageColumns: details.missingMessageColumns,
			missingColumns: details.missingColumns,
		});
	}
	if (missingExistingColumns.length > 0) {
		addMissingAdoptableCanonicalColumns(sqlite, missingExistingColumns);
		details = buildSchemaCompatibilityDetails(sqlite, {
			appliedMigrations,
			activeMigrationFiles,
		});
	}

	if (details.missingTables.length > 0) {
		applyCanonicalBaselineDdl(sqlite);
		details = buildSchemaCompatibilityDetails(sqlite, {
			appliedMigrations,
			activeMigrationFiles,
		});
	}

	if (details.missingMessageColumns.length > 0) {
		throw new SchemaResetRequiredError({
			missingTables: details.missingTables,
			missingMessageColumns: details.missingMessageColumns,
			missingColumns: details.missingColumns,
		});
	}
	if (!canAdoptCanonicalHistory(details)) {
		throw new SchemaResetRequiredError({
			missingTables: details.missingTables,
			missingMessageColumns: details.missingMessageColumns,
			missingColumns: details.missingColumns,
		});
	}
	if (details.missingColumns.length > 0) {
		addMissingAdoptableCanonicalColumns(sqlite, details.missingColumns);
	}

	applyCanonicalBaselineDdl(sqlite);
	const adoptedDetails = buildSchemaCompatibilityDetails(sqlite, {
		appliedMigrations: activeMigrationFiles,
		activeMigrationFiles,
	});
	if (
		adoptedDetails.missingTables.length > 0 ||
		adoptedDetails.missingMessageColumns.length > 0 ||
		adoptedDetails.missingColumns.length > 0
	) {
		throw new SchemaResetRequiredError({
			missingTables: adoptedDetails.missingTables,
			missingMessageColumns: adoptedDetails.missingMessageColumns,
			missingColumns: adoptedDetails.missingColumns,
		});
	}

	restampCanonicalMigrationHistory(sqlite, activeMigrationFiles);
	assertBaselineSchemaCompatibility(sqlite, {
		orgId,
		appliedMigrations: activeMigrationFiles,
		activeMigrationFiles,
	});
	await ensureAccountOwnershipBackfill(orgId);
}

export function defaultMigrationTargetOrgIds() {
	const discovered = discoverOrgIdsWithDatabases();
	return discovered.length > 0 ? discovered : [defaultOrgId()];
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
