-- 008: Finance upload ingestion state for PDF/ZIP document processing.

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

CREATE INDEX IF NOT EXISTS finance_import_uploads_status_idx
  ON finance_import_uploads (status, updated_at);
DROP INDEX IF EXISTS finance_import_uploads_sha_idx;
CREATE UNIQUE INDEX IF NOT EXISTS finance_import_uploads_sha_idx
  ON finance_import_uploads (org_id, upload_sha256);
CREATE INDEX IF NOT EXISTS finance_import_upload_files_upload_idx
  ON finance_import_upload_files (upload_id, status);
CREATE INDEX IF NOT EXISTS finance_import_upload_pages_file_idx
  ON finance_import_upload_pages (upload_file_id, selected_for_llm, page_number);
CREATE INDEX IF NOT EXISTS finance_import_upload_extractions_upload_idx
  ON finance_import_upload_extractions (upload_id, created_at);
