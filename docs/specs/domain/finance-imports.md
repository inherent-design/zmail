# Finance Imports

## Purpose

This document defines the finance artifact import contract for zmail vNext.

## Scope

Covered here:

- artifact schema
- PDF/ZIP upload extraction surface
- CLI and HTTP import surfaces
- auth model
- dedup semantics
- duplicate behavior
- storage contract
- local system dependencies

## Artifact Schema

Active artifact schema:

- `schemaVersion = "finance-source-import.v2"`
- `sourceKind`
- `sourceFile`
- `artifactSha256`
- `extractor`
- `registrySuggestions`
- `documents`
- `transactions`
- `provenance`

### `sourceFile`

- `absolutePath`
- `sha256`
- `filename`
- `importedAt`

### `extractor`

- `runner`
- `model`
- `promptVersion`
- `extractedTextHash`

### `documents[]`

V2 document rows add:

- `sourceDocumentRef`
- `documentType`
- `issuer`
- `externalId`
- `statementPeriodStart`
- `statementPeriodEnd`
- `statementOpeningBalance`
- `statementClosingBalance`
- `statementCurrency`
- `dueAt`
- `taxYear`
- `ownerIdentityHint`
- `financialAccountHint`
- `institutionHint`
- `accountMappingKey`
- `extractionConfidence`
- `rowProvenance`
- `rawPayload`
- `evidenceText`

### `transactions[]`

V2 transaction rows add:

- `externalTransactionId`
- `sourceDocumentRef`
- `occurredAt`
- `postedAt`
- `clearedAt`
- `amount`
- `currency`
- `direction`
- `description`
- `merchantOrCounterparty`
- `balance`
- `ownerIdentityHint`
- `financialAccountHint`
- `institutionHint`
- `accountMappingKey`
- `categoryPrimary`
- `categorySecondary`
- `book`
- `businessUsePercent`
- `extractionConfidence`
- `rowProvenance`
- `rawPayload`
- `evidenceText`

## Import Surfaces

### PDF/ZIP Uploads

Canonical browser/operator upload API:

- `POST /api/finance/uploads`

Request:

- `multipart/form-data`
- fields:
  - `file`: required PDF or ZIP
  - `mode`: optional, `auto | direct_llm | voyage_gate`, default `auto`
  - `sourceKindHint`: optional, `pdf | statement`

Response:

- `202`
  - `ok: true`
  - `uploadId`
  - `jobId`
  - `status: "queued"`

Rules:

- upload callers use the same browser auth boundary as finance import operators
- files are stored under the org runtime root:
  - `data/orgs/<orgId>/operator/imports/uploads/<uploadId>/`
- ZIP entry names are display/provenance only; storage paths are generated from
  content and row ids
- ZIP traversal, symlink entries, empty files, and nested ZIPs are rejected
- PDFs are probed with embedded PDF text only; OCR is not introduced
- rendered PDF pages may be routed through Voyage multimodal embeddings before
  extraction LLM calls
- Voyage-routed uploads require `VOYAGE_API_KEY` in the worker runtime
  environment
- Voyage vectors are not persisted by default; only model name, vector
  dimension, vector hash, candidate score, page hashes, and selection metadata
  are stored
- final output is still a `finance-source-import.v2` artifact and is submitted
  through the existing import flow

`mode` behavior:

- `direct_llm`: skip Voyage and send selected text/page batches to extraction
  LLMs
- `voyage_gate`: render and embed pages before LLM extraction
- `auto`: skip Voyage only when embedded text probes show enough transaction
  rows; use Voyage for scanned, layout-heavy, long, ZIP, or weak-text uploads

The upload worker emits one merged artifact per upload, queues
`import_finance_artifact`, then the import completion path queues
`rebuild_finance_knowledge` before finance rollups and mapping candidate
generation.

### CLI

Canonical admin/operator CLI:

- `pnpm finance:import --org <orgId> <artifact.json>`

The CLI must resolve the org runtime root before import and call the same shared
import service used by HTTP.

The shared import service owns artifact idempotency for CLI, HTTP worker jobs,
and direct repair calls. Re-importing the same artifact returns
`status: "already_imported"` with the existing import run id.

### HTTP

Canonical app-relative API:

- `POST /api/finance/imports`

This is the only active external finance import API.

Rules:

- the effective external path is `${base_path}/api/finance/imports`
- with the default `base_path = "/"`, the effective path is `/api/finance/imports`

## Auth Model

Allowed callers:

- browser users with a WorkOS session in the target org and role
  `org_admin` or `org_operator`
- org-scoped WorkOS M2M bearer tokens carrying `org_id`

Forbidden callers:

- unauthenticated clients
- authenticated `org_viewer` users
- cross-org machine tokens

## Dedup Semantics

Finance imports are artifact-idempotent.

Rules:

- `artifactSha256` is the dedup key
- `sourceFile.sha256` is not a uniqueness key
- re-importing the exact same artifact is treated as an already-imported success
- importing the same source file with a new artifact hash is allowed

Rationale:

- extractor/model/prompt changes may produce a new artifact from the same source
  file
- dedup should block exact duplicate ledger contribution, not valid re-extraction

## Duplicate Behavior

Exact duplicate artifact:

- do not create a second import run
- do not create a second set of imported transactions or documents
- return the existing import run identity

## HTTP Response Contract

### Success

- `200`
  - `ok: true`
  - `status: "already_imported"`
  - `importRunId`
  - `artifactSha256`

- `202`
  - `ok: true`
  - `status: "queued"`
  - `jobId`
  - `artifactSha256`

### Failure

- `400`
  - `ok: false`
  - `error: "invalid_json"`

- `401`
  - `ok: false`
  - `error: "unauthenticated"`

- `403`
  - `ok: false`
  - `error: "forbidden"`

- `422`
  - `ok: false`
  - `error: "invalid_artifact"`
  - `issues`

## Queue Semantics

`import_finance_artifact` job idempotency uses:

- `scope_type = "system"`
- `scope_id = artifactSha256`

Queue idempotency and DB uniqueness must use the same key.

`process_finance_upload` job idempotency uses:

- `scope_type = "finance_upload"`
- `scope_id = uploadId`

## Storage Contract

### `finance_import_uploads`

Must store:

- `id`
- `org_id`
- `status`
- `mode`
- `source_kind_hint`
- `upload_sha256`
- `original_filename`
- `stored_path`
- `total_bytes`
- `artifact_sha256`
- `import_run_id`
- `error_json`
- `created_at`
- `updated_at`

### `finance_import_upload_files`

Must store:

- `id`
- `upload_id`
- `logical_path`
- `stored_path`
- `mime_type`
- `sha256`
- `size_bytes`
- `page_count`
- `status`
- `created_at`

### `finance_import_upload_pages`

Must store:

- `id`
- `upload_file_id`
- `page_number`
- `image_path`
- `image_sha256`
- `width`
- `height`
- `text_probe_chars`
- `voyage_model`
- `embedding_dimension`
- `embedding_sha256`
- `candidate_score`
- `candidate_reasons_json`
- `selected_for_llm`
- `created_at`

No raw vector column is part of the default storage contract.

### `finance_import_upload_extractions`

Must store:

- `id`
- `upload_id`
- `model`
- `prompt_version`
- `input_page_refs_json`
- `output_artifact_sha256`
- `usage_json`
- `error_json`
- `created_at`

### `finance_import_runs`

Must store:

- `id`
- `source_kind`
- `source_file_path`
- `source_file_sha256`
- `filename`
- `artifact_sha256`
- `extractor_runner`
- `extractor_model`
- `extractor_prompt_version`
- `extracted_text_hash`
- `status`
- `raw_artifact_json`
- `imported_at`

Constraints:

- `artifact_sha256` is unique within one org DB
- `source_file_sha256` is indexed for diagnostics, not unique

### Dependent tables

- `finance_import_documents`
- `finance_import_transactions`
- `registry_suggestions`

These rows are attached to one canonical import run.

## External Extractor Flow

Supported flow:

1. external tool extracts a PDF/statement into `finance-source-import.v2`
2. tool computes `artifactSha256`
3. tool either:
   - submits through the app-relative `POST /api/finance/imports` endpoint with
     a WorkOS machine token
   - or writes JSON for `pnpm finance:import --org <orgId>`
4. zmail imports or dedups the artifact

Current helper status: `scripts/submit_finance_artifact.py` is a local/dev thin
submitter. It accepts a URL and posts JSON, but does not yet acquire WorkOS
machine tokens or derive `base_path`. Treat it as a convenience wrapper, not the
production external extractor client.

## Local System Dependencies

zmail does not use project-local `mise` tool linking for every system binary.
The following CLIs are machine-level dependencies for finance workflows.

Required for PDF/ZIP upload processing:

- Poppler:
  - `pdfinfo`
  - `pdftotext`
  - `pdftoppm`
- Voyage API key:
  - `VOYAGE_API_KEY`, required when routing through Voyage multimodal embeddings

Required for full Beancount/Fava export workflows:

- Beancount:
  - `bean-check`
- Fava:
  - `fava`
- uv:
  - `uvx`, used by the `finance:fava` task as a fallback launcher

Missing Poppler binaries fail upload extraction. Missing `bean-check` skips
Beancount validation during export; install Beancount for full validation.

## Failure Modes

- malformed JSON: `400`
- invalid schema: `422`
- auth failure: `401` or `403`
- duplicate artifact: `200 already_imported`
- storage uniqueness race: collapse to the same duplicate outcome rather than
  creating a second ledger contribution

## Out Of Scope

- unauthenticated local-only HTTP imports
- dedup by `sourceFile.sha256`
- direct Plaid ingestion
- persistent vector search for uploads
