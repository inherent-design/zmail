CREATE TABLE IF NOT EXISTS finance_v3_clean_guard (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO finance_v3_clean_guard (id, note, created_at)
VALUES (
  'manual-clean-required',
  'Legacy finance candidate tables are intentionally not dropped by automatic migrations. Use classify:migrate-finance-v3 --clean --confirm-clean after archive, reclassify, rebuild, export, and review are accepted.',
  datetime('now')
);
