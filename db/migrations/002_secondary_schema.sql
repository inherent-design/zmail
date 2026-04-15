CREATE TABLE IF NOT EXISTS message_secondary_results (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  classifier_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  source TEXT NOT NULL,
  result_json TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  usage_json TEXT,
  input_content_sha256 TEXT,
  input_registry_sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS message_secondary_results_message_classifier_created_idx
  ON message_secondary_results (message_id, classifier_key, created_at DESC);

CREATE INDEX IF NOT EXISTS message_secondary_results_classifier_created_idx
  ON message_secondary_results (classifier_key, created_at DESC);

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
  notes TEXT
);

CREATE TABLE IF NOT EXISTS registry_institutions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  domains_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT
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
  notes TEXT
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
  notes TEXT
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
