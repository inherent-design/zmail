PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE jobs_new (
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
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO jobs_new (
  id,
  kind,
  scope_type,
  scope_id,
  status,
  model,
  prompt_version,
  request_count,
  success_count,
  error_count,
  claimed_at,
  lease_expires_at,
  attempts,
  last_error,
  created_at,
  started_at,
  finished_at,
  meta_json
)
SELECT
  id,
  kind,
  scope_type,
  scope_id,
  status,
  model,
  prompt_version,
  request_count,
  success_count,
  error_count,
  claimed_at,
  lease_expires_at,
  attempts,
  last_error,
  created_at,
  started_at,
  finished_at,
  meta_json
FROM jobs;

DROP TABLE jobs;

ALTER TABLE jobs_new RENAME TO jobs;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_open_scope_idx
  ON jobs (kind, scope_type, scope_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS jobs_status_created_idx
  ON jobs (status, created_at);

COMMIT;

PRAGMA foreign_keys=ON;
