CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email_address TEXT NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'gmail',
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  source_truth TEXT NOT NULL DEFAULT 'corpus_mirror',
  selected_mailbox TEXT NOT NULL DEFAULT '[Gmail]/All Mail',
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sync_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  uidvalidity INTEGER,
  last_seen_uid INTEGER,
  last_full_sync_started_at TEXT,
  last_full_sync_completed_at TEXT,
  last_delta_sync_at TEXT,
  last_reconcile_at TEXT,
  last_idle_started_at TEXT,
  last_idle_heartbeat_at TEXT,
  watcher_status TEXT NOT NULL DEFAULT 'stopped',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  received_at TEXT,
  sender_name TEXT,
  sender_address TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT,
  in_reply_to TEXT,
  body_text_normalized TEXT NOT NULL,
  snippet TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  has_html INTEGER NOT NULL DEFAULT 0,
  raw_byte_start INTEGER NOT NULL DEFAULT 0,
  raw_byte_end INTEGER NOT NULL DEFAULT 0,
  parse_status TEXT NOT NULL,
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
  batch_id TEXT,
  input_file_path TEXT,
  output_file_path TEXT,
  error_file_path TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  lease_expires_at TEXT,
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
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
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
  source TEXT NOT NULL,
  label_json TEXT NOT NULL,
  primary_bucket TEXT NOT NULL,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  nsfw INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  updated_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS overseer_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  built_from_messages INTEGER NOT NULL DEFAULT 0,
  promoted_tags_json TEXT NOT NULL,
  prompt_preamble TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_account_message_id_idx
  ON messages (account_id, message_id);

CREATE INDEX IF NOT EXISTS messages_account_received_idx
  ON messages (account_id, received_at DESC);

CREATE INDEX IF NOT EXISTS messages_account_thread_idx
  ON messages (account_id, thread_key);

CREATE INDEX IF NOT EXISTS messages_subject_idx
  ON messages (subject);

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

CREATE INDEX IF NOT EXISTS classification_results_message_created_idx
  ON classification_results (message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_labels_bucket_confidence_idx
  ON message_labels (primary_bucket, low_confidence);

CREATE INDEX IF NOT EXISTS reviews_status_created_idx
  ON reviews (status, created_at);

CREATE INDEX IF NOT EXISTS overseer_profiles_account_created_idx
  ON overseer_profiles (account_id, created_at DESC);
