ALTER TABLE classification_results
ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'message-label.v1';

ALTER TABLE message_labels
ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'message-label.v1';

ALTER TABLE registry_identities
ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';

ALTER TABLE registry_institutions
ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';

ALTER TABLE registry_financial_accounts
ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';

ALTER TABLE registry_sender_rules
ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'operator';

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
  created_at TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS classification_rules_rule_set_priority_idx
  ON classification_rules (rule_set_key, priority, rule_key);

CREATE INDEX IF NOT EXISTS message_category_assignments_message_created_idx
  ON message_category_assignments (message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS finance_import_transactions_run_idx
  ON finance_import_transactions (import_run_id, occurred_at);

CREATE INDEX IF NOT EXISTS finance_import_documents_run_idx
  ON finance_import_documents (import_run_id, statement_period_end);

CREATE INDEX IF NOT EXISTS registry_suggestions_entity_status_idx
  ON registry_suggestions (entity_kind, status, canonical_key);

CREATE INDEX IF NOT EXISTS finance_yearly_rollups_year_idx
  ON finance_yearly_rollups (year, source_kind, primary_category);

CREATE INDEX IF NOT EXISTS finance_yearly_subcategory_rollups_year_idx
  ON finance_yearly_subcategory_rollups (year, source_kind, primary_category, secondary_category);
