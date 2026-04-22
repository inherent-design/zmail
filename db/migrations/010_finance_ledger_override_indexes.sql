CREATE INDEX IF NOT EXISTS finance_ledger_entry_overrides_status_updated_idx
  ON finance_ledger_entry_overrides (status, updated_at)
  WHERE status = 'active';
