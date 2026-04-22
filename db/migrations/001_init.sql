-- 001: Canonical rewritten baseline for the full current zmail SQLite schema.
-- Later migration files in this cleanup window are stable history stamps or
-- idempotent compatibility DDL only.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email_address TEXT NOT NULL,
  owner_principal_email TEXT,
  provider_kind TEXT NOT NULL DEFAULT 'gmail',
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  source_truth TEXT NOT NULL DEFAULT 'corpus_mirror',
  selected_mailbox TEXT NOT NULL DEFAULT '[Gmail]/All Mail',
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  connection_state TEXT NOT NULL DEFAULT 'connected'
  CHECK (connection_state IN ('connected', 'config_error', 'paused', 'needs_reconnect', 'disconnected')));
CREATE TABLE IF NOT EXISTS account_sync_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  uidvalidity INTEGER,
  latest_uid_cursor INTEGER,
  earliest_uid_cursor INTEGER,
  backfill_snapshot_uid INTEGER,
  backfill_next_uid INTEGER,
  last_bootstrap_started_at TEXT,
  last_bootstrap_completed_at TEXT,
  last_delta_sync_at TEXT,
  last_reconcile_at TEXT,
  last_backfill_sync_at TEXT,
  backfill_completed_at TEXT,
  last_idle_started_at TEXT,
  last_idle_heartbeat_at TEXT,
  watcher_status TEXT NOT NULL DEFAULT 'stopped',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  first_message_received_at TEXT,
  last_message_received_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, gmail_thread_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  received_at TEXT,
  ingested_at TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  sender_name TEXT,
  sender_address TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT,
  in_reply_to TEXT,
  body_text_primary TEXT NOT NULL DEFAULT '',
  body_text_forwarded TEXT NOT NULL DEFAULT '',
  body_text_normalized TEXT NOT NULL,
  snippet TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  has_html INTEGER NOT NULL DEFAULT 0,
  raw_byte_start INTEGER NOT NULL DEFAULT 0,
  raw_byte_end INTEGER NOT NULL DEFAULT 0,
  parse_status TEXT NOT NULL,
  body_extraction_strategy TEXT NOT NULL DEFAULT 'plain_text',
  parse_error_reason TEXT,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_message_id TEXT,
  remote_thread_id TEXT,
  mailbox TEXT,
  imap_uid INTEGER,
  uidvalidity INTEGER,
  raw_rfc822_path TEXT,
  raw_sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  tombstoned_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  lease_expires_at TEXT,
  lane TEXT NOT NULL DEFAULT 'materialize',
  priority INTEGER NOT NULL DEFAULT 100,
  run_after_at TEXT,
  claim_owner TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS moderation_results (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  category_scores_json TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  nsfw_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classification_results (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT 'message-label.v1',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_sha256 TEXT,
  source TEXT NOT NULL,
  result_json TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  usage_json TEXT,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  input_content_sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_labels (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  classification_result_id TEXT NOT NULL REFERENCES classification_results(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT 'message-label.v1',
  source TEXT NOT NULL,
  label_json TEXT NOT NULL,
  primary_bucket TEXT NOT NULL,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  nsfw INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_secondary_results (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  classifier_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_sha256 TEXT,
  source TEXT NOT NULL,
  result_json TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  usage_json TEXT,
  input_content_sha256 TEXT,
  input_registry_sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_secondary_heads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  classifier_key TEXT NOT NULL,
  secondary_result_id TEXT REFERENCES message_secondary_results(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  registry_sha256 TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, classifier_key)
);
CREATE TABLE IF NOT EXISTS registry_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  email_addresses_json TEXT NOT NULL DEFAULT '[]',
  domains_json TEXT NOT NULL DEFAULT '[]',
  tax_owner_hint TEXT,
  notes TEXT,
  source_kind TEXT NOT NULL DEFAULT 'operator'
);
CREATE TABLE IF NOT EXISTS registry_institutions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  domains_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  source_kind TEXT NOT NULL DEFAULT 'operator'
);
CREATE TABLE IF NOT EXISTS registry_financial_accounts (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES registry_institutions(id) ON DELETE SET NULL,
  owner_identity_id TEXT REFERENCES registry_identities(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  account_mask TEXT,
  account_last4 TEXT,
  account_type TEXT,
  currency TEXT,
  tax_owner_hint TEXT,
  notes TEXT,
  source_kind TEXT NOT NULL DEFAULT 'operator'
);
CREATE TABLE IF NOT EXISTS registry_sender_rules (
  id TEXT PRIMARY KEY,
  sender_pattern TEXT NOT NULL,
  domain TEXT,
  owner_identity_id TEXT REFERENCES registry_identities(id) ON DELETE SET NULL,
  institution_id TEXT REFERENCES registry_institutions(id) ON DELETE SET NULL,
  financial_account_id TEXT REFERENCES registry_financial_accounts(id) ON DELETE SET NULL,
  message_kind_hint TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  source_kind TEXT NOT NULL DEFAULT 'operator'
);
CREATE TABLE IF NOT EXISTS registry_import_state (
  key TEXT PRIMARY KEY,
  combined_sha256 TEXT NOT NULL,
  source_dir TEXT NOT NULL,
  counts_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_event_candidates (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'candidate',
  event_kind TEXT NOT NULL,
  direction TEXT,
  amount_value TEXT,
  currency TEXT,
  occurred_at TEXT,
  merchant_or_counterparty TEXT,
  owner_identity_id TEXT REFERENCES registry_identities(id) ON DELETE SET NULL,
  financial_account_id TEXT REFERENCES registry_financial_accounts(id) ON DELETE SET NULL,
  institution_id TEXT REFERENCES registry_institutions(id) ON DELETE SET NULL,
  category_hint TEXT,
  tax_relevance_hint TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  first_message_received_at TEXT,
  last_message_received_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_document_candidates (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'candidate',
  document_type TEXT NOT NULL,
  issuer TEXT,
  external_id TEXT,
  statement_period_start TEXT,
  statement_period_end TEXT,
  due_at TEXT,
  tax_year INTEGER,
  owner_identity_id TEXT REFERENCES registry_identities(id) ON DELETE SET NULL,
  financial_account_id TEXT REFERENCES registry_financial_accounts(id) ON DELETE SET NULL,
  institution_id TEXT REFERENCES registry_institutions(id) ON DELETE SET NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  first_message_received_at TEXT,
  last_message_received_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_event_evidence (
  id TEXT PRIMARY KEY,
  event_candidate_id TEXT REFERENCES finance_event_candidates(id) ON DELETE CASCADE,
  document_candidate_id TEXT REFERENCES finance_document_candidates(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  secondary_result_id TEXT NOT NULL REFERENCES message_secondary_results(id) ON DELETE CASCADE,
  transaction_index INTEGER,
  document_index INTEGER,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_classification_result_id TEXT NOT NULL REFERENCES classification_results(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reviewer_note TEXT,
  override_label_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS review_classification_results (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  schema_version TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_sha256 TEXT,
  source TEXT NOT NULL,
  input_summary_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_classification_heads (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result_id TEXT NOT NULL REFERENCES review_classification_results(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  resolution_note TEXT,
  decided_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
CREATE TABLE IF NOT EXISTS overseer_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  built_from_messages INTEGER NOT NULL DEFAULT 0,
  promoted_tags_json TEXT NOT NULL,
  prompt_preamble TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classification_rule_sets (
  key TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classification_rules (
  id TEXT PRIMARY KEY,
  rule_set_key TEXT NOT NULL REFERENCES classification_rule_sets(key) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_json TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (rule_set_key, rule_key)
);
CREATE TABLE IF NOT EXISTS message_category_assignments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  matched_rule_key TEXT,
  projected_primary_category TEXT NOT NULL,
  projected_secondary_category TEXT,
  projected_finance_primary TEXT,
  projected_finance_secondary TEXT,
  result_json TEXT NOT NULL,
  input_content_sha256 TEXT,
  rule_set_sha256 TEXT,
  finance_result_id TEXT REFERENCES message_secondary_results(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_category_assignment_heads (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES message_category_assignments(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  input_content_sha256 TEXT,
  rule_set_sha256 TEXT,
  finance_result_id TEXT REFERENCES message_secondary_results(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_import_runs (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  source_file_sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  extractor_runner TEXT NOT NULL,
  extractor_model TEXT NOT NULL,
  extractor_prompt_version TEXT NOT NULL,
  extracted_text_hash TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  raw_artifact_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_import_documents (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES finance_import_runs(id) ON DELETE CASCADE,
  source_document_ref TEXT,
  document_type TEXT NOT NULL,
  issuer TEXT,
  external_id TEXT,
  statement_period_start TEXT,
  statement_period_end TEXT,
  due_at TEXT,
  tax_year INTEGER,
  owner_identity_hint TEXT,
  financial_account_hint TEXT,
  institution_hint TEXT,
  evidence_text TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  statement_opening_balance TEXT,
  statement_closing_balance TEXT,
  statement_transaction_count INTEGER,
  statement_currency TEXT,
  account_mapping_key TEXT,
  extraction_confidence REAL NOT NULL DEFAULT 0,
  raw_document_payload_json TEXT NOT NULL DEFAULT '{}',
  raw_payload_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS finance_import_transactions (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES finance_import_runs(id) ON DELETE CASCADE,
  source_document_ref TEXT,
  occurred_at TEXT,
  posted_at TEXT,
  amount_value TEXT,
  amount_minor INTEGER,
  currency TEXT,
  direction TEXT NOT NULL,
  description TEXT,
  merchant_or_counterparty TEXT,
  balance_value TEXT,
  owner_identity_hint TEXT,
  financial_account_hint TEXT,
  institution_hint TEXT,
  category_primary TEXT,
  category_secondary TEXT,
  evidence_text TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  external_transaction_id TEXT,
  cleared_at TEXT,
  statement_row_id TEXT,
  row_index INTEGER,
  account_mapping_key TEXT,
  book_hint TEXT NOT NULL DEFAULT 'unknown',
  business_use_percent REAL,
  extraction_confidence REAL NOT NULL DEFAULT 0,
  raw_row_payload_json TEXT NOT NULL DEFAULT '{}',
  row_provenance_json TEXT NOT NULL DEFAULT '{}',
  raw_payload_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS finance_import_uploads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  mode TEXT NOT NULL DEFAULT 'auto',
  source_kind_hint TEXT,
  upload_sha256 TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  artifact_sha256 TEXT,
  import_run_id TEXT REFERENCES finance_import_runs(id) ON DELETE SET NULL,
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_import_upload_files (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES finance_import_uploads(id) ON DELETE CASCADE,
  logical_path TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_import_upload_pages (
  id TEXT PRIMARY KEY,
  upload_file_id TEXT NOT NULL REFERENCES finance_import_upload_files(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path TEXT,
  image_sha256 TEXT,
  width INTEGER,
  height INTEGER,
  text_probe_chars INTEGER NOT NULL DEFAULT 0,
  voyage_model TEXT,
  embedding_dimension INTEGER,
  embedding_sha256 TEXT,
  candidate_score REAL,
  candidate_reasons_json TEXT NOT NULL DEFAULT '[]',
  selected_for_llm INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (upload_file_id, page_number)
);
CREATE TABLE IF NOT EXISTS finance_import_upload_extractions (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES finance_import_uploads(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_page_refs_json TEXT NOT NULL DEFAULT '[]',
  output_artifact_sha256 TEXT,
  usage_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_suggestions (
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  suggestion_json TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  applied_registry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_yearly_rollups (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  inflow_minor INTEGER NOT NULL DEFAULT 0,
  outflow_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  imported_statement_count INTEGER NOT NULL DEFAULT 0,
  extracted_transaction_count INTEGER NOT NULL DEFAULT 0,
  uncategorized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (year, source_kind, primary_category)
);
CREATE TABLE IF NOT EXISTS finance_yearly_subcategory_rollups (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  secondary_category TEXT NOT NULL,
  inflow_minor INTEGER NOT NULL DEFAULT 0,
  outflow_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (year, source_kind, primary_category, secondary_category)
);
CREATE TABLE IF NOT EXISTS runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_kind TEXT,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_account_message_id_idx
  ON messages (account_id, message_id);
CREATE INDEX IF NOT EXISTS messages_account_received_idx
  ON messages (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_account_thread_idx
  ON messages (account_id, thread_key);
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS messages_subject_idx
  ON messages (subject);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_address_idx
  ON accounts (email_address);
CREATE UNIQUE INDEX IF NOT EXISTS message_sources_account_remote_idx
  ON message_sources (account_id, remote_message_id)
  WHERE remote_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_sources_message_idx
  ON message_sources (message_id);
CREATE INDEX IF NOT EXISTS message_sources_state_idx
  ON message_sources (account_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_open_scope_idx
  ON jobs (kind, scope_type, scope_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_status_created_idx
  ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_lane_status_priority_idx
  ON jobs (lane, status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_run_after_idx
  ON jobs (status, run_after_at);
CREATE INDEX IF NOT EXISTS classification_results_message_created_idx
  ON classification_results (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS classification_results_message_prompt_idx
  ON classification_results (message_id, prompt_version, prompt_sha256);
CREATE INDEX IF NOT EXISTS message_labels_bucket_confidence_idx
  ON message_labels (primary_bucket, low_confidence);
CREATE INDEX IF NOT EXISTS message_secondary_results_message_classifier_created_idx
  ON message_secondary_results (message_id, classifier_key, created_at DESC);
CREATE INDEX IF NOT EXISTS message_secondary_results_message_classifier_prompt_idx
  ON message_secondary_results (message_id, classifier_key, prompt_version, prompt_sha256);
CREATE INDEX IF NOT EXISTS message_secondary_results_classifier_created_idx
  ON message_secondary_results (classifier_key, created_at DESC);
CREATE INDEX IF NOT EXISTS message_secondary_heads_classifier_status_idx
  ON message_secondary_heads (classifier_key, status);
CREATE INDEX IF NOT EXISTS registry_sender_rules_priority_idx
  ON registry_sender_rules (priority, sender_pattern);
CREATE INDEX IF NOT EXISTS finance_event_candidates_updated_idx
  ON finance_event_candidates (updated_at DESC);
CREATE INDEX IF NOT EXISTS finance_document_candidates_updated_idx
  ON finance_document_candidates (updated_at DESC);
CREATE INDEX IF NOT EXISTS finance_event_evidence_message_idx
  ON finance_event_evidence (message_id);
CREATE INDEX IF NOT EXISTS finance_event_evidence_event_idx
  ON finance_event_evidence (event_candidate_id);
CREATE INDEX IF NOT EXISTS finance_event_evidence_document_idx
  ON finance_event_evidence (document_candidate_id);
CREATE INDEX IF NOT EXISTS reviews_status_created_idx
  ON reviews (status, created_at);
CREATE INDEX IF NOT EXISTS review_classification_results_created_idx
  ON review_classification_results (created_at DESC);
CREATE INDEX IF NOT EXISTS review_classification_heads_status_idx
  ON review_classification_heads (status, severity, updated_at DESC);
CREATE INDEX IF NOT EXISTS overseer_profiles_account_created_idx
  ON overseer_profiles (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS classification_rules_rule_set_priority_idx
  ON classification_rules (rule_set_key, priority, rule_key);
CREATE INDEX IF NOT EXISTS message_category_assignments_message_created_idx
  ON message_category_assignments (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS finance_import_transactions_run_idx
  ON finance_import_transactions (import_run_id, occurred_at);
CREATE INDEX IF NOT EXISTS finance_import_documents_run_idx
  ON finance_import_documents (import_run_id, statement_period_end);
CREATE UNIQUE INDEX IF NOT EXISTS finance_import_runs_artifact_sha_idx
  ON finance_import_runs (artifact_sha256);
CREATE INDEX IF NOT EXISTS finance_import_runs_source_file_sha_idx
  ON finance_import_runs (source_file_sha256);
CREATE INDEX IF NOT EXISTS finance_import_uploads_status_idx
  ON finance_import_uploads (status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS finance_import_uploads_sha_idx
  ON finance_import_uploads (org_id, upload_sha256);
CREATE INDEX IF NOT EXISTS finance_import_upload_files_upload_idx
  ON finance_import_upload_files (upload_id, status);
CREATE INDEX IF NOT EXISTS finance_import_upload_pages_file_idx
  ON finance_import_upload_pages (upload_file_id, selected_for_llm, page_number);
CREATE INDEX IF NOT EXISTS finance_import_upload_extractions_upload_idx
  ON finance_import_upload_extractions (upload_id, created_at);
CREATE INDEX IF NOT EXISTS registry_suggestions_entity_status_idx
  ON registry_suggestions (entity_kind, status, canonical_key);
CREATE INDEX IF NOT EXISTS finance_yearly_rollups_year_idx
  ON finance_yearly_rollups (year, source_kind, primary_category);
CREATE INDEX IF NOT EXISTS finance_yearly_subcategory_rollups_year_idx
  ON finance_yearly_subcategory_rollups (year, source_kind, primary_category, secondary_category);
CREATE INDEX IF NOT EXISTS runtime_events_topic_id_idx
  ON runtime_events (topic, id);
CREATE INDEX IF NOT EXISTS runtime_events_created_at_idx
  ON runtime_events (created_at);
CREATE TABLE IF NOT EXISTS finance_ledger_entries (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'review',
  source_authority TEXT NOT NULL,
  occurred_at TEXT,
  posted_at TEXT,
  cleared_at TEXT,
  description TEXT,
  counterparty TEXT,
  direction TEXT NOT NULL,
  amount_value TEXT,
  amount_minor INTEGER,
  currency TEXT,
  book TEXT NOT NULL DEFAULT 'unknown',
  business_use_percent REAL,
  debit_account TEXT,
  credit_account TEXT,
  account_mapping_key TEXT,
  field_confidence_json TEXT NOT NULL DEFAULT '{}',
  ledger_metadata_json TEXT NOT NULL DEFAULT '{}',
  raw_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_ledger_entry_sources (
  id TEXT PRIMARY KEY,
  ledger_entry_id TEXT REFERENCES finance_ledger_entries(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  secondary_result_id TEXT REFERENCES message_secondary_results(id) ON DELETE SET NULL,
  import_run_id TEXT REFERENCES finance_import_runs(id) ON DELETE CASCADE,
  import_transaction_id TEXT REFERENCES finance_import_transactions(id) ON DELETE CASCADE,
  import_document_id TEXT REFERENCES finance_import_documents(id) ON DELETE CASCADE,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_ledger_entry_overrides (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  relationship_patch_json TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  actor_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT
);
CREATE TABLE IF NOT EXISTS finance_patterns (
  id TEXT PRIMARY KEY,
  pattern_kind TEXT NOT NULL,
  pattern_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_export_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  strict INTEGER NOT NULL DEFAULT 1,
  year INTEGER,
  out_dir TEXT NOT NULL,
  package_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS finance_export_items (
  id TEXT PRIMARY KEY,
  export_run_id TEXT NOT NULL REFERENCES finance_export_runs(id) ON DELETE CASCADE,
  ledger_entry_id TEXT REFERENCES finance_ledger_entries(id) ON DELETE SET NULL,
  canonical_key TEXT NOT NULL,
  status TEXT NOT NULL,
  beancount_link TEXT,
  sidecar_reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tax_report_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  report_kind TEXT NOT NULL,
  year INTEGER NOT NULL,
  quarter INTEGER,
  business_slug TEXT,
  out_dir TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS finance_account_mappings (
  id TEXT PRIMARY KEY,
  mapping_key TEXT NOT NULL UNIQUE,
  book TEXT NOT NULL DEFAULT 'unknown',
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  currency TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  debit_account TEXT,
  credit_account TEXT,
  match_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  source_path TEXT);
CREATE INDEX IF NOT EXISTS finance_import_transactions_external_idx
  ON finance_import_transactions (external_transaction_id);
CREATE INDEX IF NOT EXISTS finance_import_transactions_statement_row_idx
  ON finance_import_transactions (statement_row_id);
CREATE INDEX IF NOT EXISTS finance_ledger_entries_status_idx
  ON finance_ledger_entries (status, occurred_at);
CREATE INDEX IF NOT EXISTS finance_ledger_entries_book_idx
  ON finance_ledger_entries (book, occurred_at);
CREATE INDEX IF NOT EXISTS finance_ledger_entry_sources_entry_idx
  ON finance_ledger_entry_sources (ledger_entry_id);
CREATE INDEX IF NOT EXISTS finance_ledger_entry_sources_message_idx
  ON finance_ledger_entry_sources (message_id);
CREATE INDEX IF NOT EXISTS finance_ledger_entry_overrides_active_idx
  ON finance_ledger_entry_overrides (canonical_key, status, updated_at);
CREATE INDEX IF NOT EXISTS finance_patterns_kind_seen_idx
  ON finance_patterns (pattern_kind, last_seen_at);
CREATE INDEX IF NOT EXISTS finance_export_runs_created_idx
  ON finance_export_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS finance_export_items_run_idx
  ON finance_export_items (export_run_id, status);
CREATE INDEX IF NOT EXISTS tax_report_runs_created_idx
  ON tax_report_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS tax_report_runs_kind_year_idx
  ON tax_report_runs (report_kind, year, quarter, status);
CREATE INDEX IF NOT EXISTS finance_account_mappings_key_idx
  ON finance_account_mappings (mapping_key);
CREATE TABLE IF NOT EXISTS finance_model_migration_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'archived',
  archived_at TEXT NOT NULL,
  completed_at TEXT,
  cleaned_at TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  counts_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS finance_v3_archive_rows (
  id TEXT PRIMARY KEY,
  archive_run_id TEXT NOT NULL REFERENCES finance_model_migration_runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_pk TEXT,
  payload_json TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS finance_model_migration_runs_org_idx
  ON finance_model_migration_runs (org_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS finance_v3_archive_rows_run_idx
  ON finance_v3_archive_rows (archive_run_id, source_table);
CREATE INDEX IF NOT EXISTS finance_v3_archive_rows_source_idx
  ON finance_v3_archive_rows (org_id, source_table, source_pk);
CREATE INDEX IF NOT EXISTS finance_import_transactions_mapping_date_idx
  ON finance_import_transactions (account_mapping_key, occurred_at, posted_at);
CREATE INDEX IF NOT EXISTS finance_import_documents_statement_idx
  ON finance_import_documents (source_document_ref, statement_period_start, statement_period_end);
CREATE INDEX IF NOT EXISTS finance_ledger_entries_canonical_idx
  ON finance_ledger_entries (canonical_key);
CREATE INDEX IF NOT EXISTS finance_ledger_entries_authority_idx
  ON finance_ledger_entries (source_authority, occurred_at);
CREATE INDEX IF NOT EXISTS finance_ledger_entries_mapping_idx
  ON finance_ledger_entries (account_mapping_key, occurred_at);
CREATE INDEX IF NOT EXISTS finance_account_mappings_book_idx
  ON finance_account_mappings (book, mapping_key);
CREATE TABLE IF NOT EXISTS finance_v3_clean_guard (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
