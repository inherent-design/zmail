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
