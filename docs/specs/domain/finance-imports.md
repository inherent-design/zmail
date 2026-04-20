# Finance Imports

## Purpose

This document defines the finance artifact import contract for zmail vNext.

## Scope

Covered here:

- artifact schema
- CLI and HTTP import surfaces
- auth model
- dedup semantics
- duplicate behavior
- storage contract

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

## Storage Contract

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
- raw PDF storage inside zmail
