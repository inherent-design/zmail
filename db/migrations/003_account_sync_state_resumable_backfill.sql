PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE account_sync_state_new (
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

INSERT INTO account_sync_state_new (
  account_id,
  uidvalidity,
  latest_uid_cursor,
  earliest_uid_cursor,
  backfill_snapshot_uid,
  backfill_next_uid,
  last_bootstrap_started_at,
  last_bootstrap_completed_at,
  last_delta_sync_at,
  last_reconcile_at,
  last_backfill_sync_at,
  backfill_completed_at,
  last_idle_started_at,
  last_idle_heartbeat_at,
  watcher_status,
  consecutive_failures,
  backoff_until,
  created_at,
  updated_at
)
SELECT
  account_id,
  uidvalidity,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL THEN last_seen_uid
    ELSE NULL
  END,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL AND last_seen_uid IS NOT NULL THEN 1
    ELSE NULL
  END,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL THEN last_seen_uid
    ELSE NULL
  END,
  NULL,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL THEN last_full_sync_started_at
    ELSE NULL
  END,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL THEN last_full_sync_completed_at
    ELSE NULL
  END,
  last_delta_sync_at,
  last_reconcile_at,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL THEN last_full_sync_completed_at
    ELSE NULL
  END,
  CASE
    WHEN last_full_sync_completed_at IS NOT NULL THEN last_full_sync_completed_at
    ELSE NULL
  END,
  last_idle_started_at,
  last_idle_heartbeat_at,
  watcher_status,
  consecutive_failures,
  backoff_until,
  created_at,
  updated_at
FROM account_sync_state;

DROP TABLE account_sync_state;

ALTER TABLE account_sync_state_new RENAME TO account_sync_state;

COMMIT;

PRAGMA foreign_keys=ON;
