-- 009: Unified workflow source-kind cleanup and durable finance ledger overrides.

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

CREATE INDEX IF NOT EXISTS finance_ledger_entry_overrides_active_idx
  ON finance_ledger_entry_overrides (canonical_key, status, updated_at);

CREATE INDEX IF NOT EXISTS finance_ledger_entry_overrides_status_updated_idx
  ON finance_ledger_entry_overrides (status, updated_at)
  WHERE status = 'active';

UPDATE finance_import_runs
  SET source_kind = 'text'
  WHERE source_kind = 'statement';

UPDATE finance_import_uploads
  SET source_kind_hint = 'text'
  WHERE source_kind_hint = 'statement';

UPDATE finance_ledger_entries
  SET source_authority = 'text'
  WHERE source_authority = 'statement';

UPDATE finance_ledger_entry_sources
  SET source_kind = 'text'
  WHERE source_kind = 'statement';

UPDATE finance_yearly_rollups
  SET source_kind = 'text'
  WHERE source_kind = 'statement';

UPDATE finance_yearly_subcategory_rollups
  SET source_kind = 'text'
  WHERE source_kind = 'statement';

UPDATE registry_suggestions
  SET source_kind = 'text'
  WHERE source_kind = 'statement';
