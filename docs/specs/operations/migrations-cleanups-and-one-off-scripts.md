# Migrations, Cleanups, and One-Off Scripts

## Purpose

This document defines schema history policy, runtime adoption policy, import
dedup cleanup, and script classification for zmail vNext.

## Migration History Policy

Canonical migration history is target-state only:

- `001_init.sql`
  - canonical rewritten baseline for the full current SQLite schema

New schema work starts at:

- `002_*`

Historical bridge migrations are removed once their target state has been folded
into `001_init.sql`.

Temporary validation migrations are allowed during local development to prove an
upgrade path from the previous target state. Before the slice lands, validated
DDL must be promoted into `001_init.sql` and the matching final schema snapshot.
The temporary migration must then be deleted or converted to an intentional
no-op if stable numbering is required. Clean databases must not replay duplicate
`ALTER TABLE` statements for columns already present in the canonical baseline.

After a migration cleanup, active migration filenames may remain as stable
history stamps. Those stamp files must either be empty/no-op or contain only
idempotent compatibility DDL such as `CREATE TABLE IF NOT EXISTS` or
`CREATE INDEX IF NOT EXISTS`. They must not contain unguarded `ALTER TABLE ADD
COLUMN` statements once the same column has been folded into `001_init.sql`.

`--adopt-history` is a repair-and-restamp workflow:

1. verify the existing DB is close enough to the rewritten baseline
2. apply canonical idempotent baseline DDL to create any missing target tables
3. add supported canonical columns through guarded column-existence checks
4. perform required deterministic backfills for newly added columns
5. replace `_migrations` with the active migration filename set

It must not preserve stale migration filenames after successful adoption, and it
must not replay duplicate-prone historical `ALTER TABLE` statements.

## vNext Migration Policy

The rewrite may add migrations for:

- org-aware finance import dedup constraints
- metadata needed for WorkOS-backed org runtime adoption
- any schema changes required by the Hono + Hono JSX + per-org runtime model

The rewrite must not hide behavioral cleanup inside schema history when the work
is actually data repair.

## Legacy Runtime Adoption

The old single-tenant data root may exist before vNext lands.

Legacy paths:

- `data/zmail.sqlite*`
- `data/accounts/**`
- `data/operator/**`

Adoption policy:

- use a one-time org claim flow
- move legacy DB and org-local files into `data/orgs/<orgId>/...`
- run migrations after the move
- if a DB still carries stale pre-cleanup migration history, run
  `pnpm db:migrate -- --all-orgs --adopt-history`
- do not silently duplicate or partially shadow legacy data

## Finance Import Dedup Migration

### Required schema change

`finance_import_runs` must gain:

- unique constraint or unique index on `artifact_sha256`

It must not gain:

- uniqueness on `source_file_sha256`

`source_file_sha256` must gain:

- a non-unique index for diagnostics and operator lookup

## Duplicate Import Cleanup Policy

If older DBs already contain duplicate imports:

1. detect duplicate groups by `artifact_sha256`
2. choose one canonical surviving run per artifact hash
3. delete dependent rows for duplicate runs in FK-safe order:
   - `finance_import_transactions`
   - `finance_import_documents`
   - `registry_suggestions` tied to duplicate run ids
   - duplicate `finance_import_runs`
4. rebuild finance rollups
5. record the cleanup outcome

This is a data repair workflow, not a hidden migration side effect.

## When To Use What

### SQL migration

Use when:

- schema shape changes
- indexes or constraints change
- new tables or columns are required

Do not use when:

- fixing already-corrupt or duplicate data in a non-deterministic way

### One-off data repair script

Use when:

- existing local DBs may be dirty
- operator judgment or reporting is useful
- the cleanup is deterministic but should be explicit and auditable

### Operator CLI

Use when:

- the action is routine
- it should be documented and rerunnable
- it belongs in normal operator/admin workflows

### Rebuild job

Use when:

- state is derived and can be reconstructed from canonical inputs
- asynchronous/background execution is the right control plane

## Script Taxonomy

### Operator-safe

Definition:

- routine
- documented
- idempotent or safely repeatable
- org-scoped

Examples in vNext:

- `pnpm finance:import --org <orgId> <artifact.json>`
- `pnpm db:migrate -- --org <orgId>`
- `pnpm audit:corpus --org <orgId>`

### Admin/repair

Definition:

- data repair or migration support
- potentially destructive
- must be explicit and auditable

Examples:

- import dedup cleanup
- bad-body re-extraction
- parse-error re-extraction
- targeted resets

### Deprecated

Definition:

- tied to the old TanStack or single-tenant architecture
- removed once the rewrite lands or migration completes

## Current Script Decisions

| Script | vNext classification | Policy |
| --- | --- | --- |
| `scripts/import-finance-artifact.ts` | operator-safe | keep, but require `--org <orgId>` and route through the shared import service |
| `scripts/submit_finance_artifact.py` | operator-safe | keep, but require WorkOS machine-token auth for HTTP import |
| `scripts/extract_financial_pdf.py` | operator-safe | keep as external extractor companion; artifact schema stays canonical |
| `scripts/db-reset.ts` | admin/repair | re-specify for org-scoped `all`, `messages`, and `jobs` reset modes |
| `scripts/reextract-bad-bodies.ts` | admin/repair | keep as org-scoped repair tool |
| `scripts/reextract-parse-errors.ts` | admin/repair | keep as org-scoped repair tool |
| `scripts/worker-drain.ts` | admin/repair | keep as org-scoped or all-org drain/debug tool |
| `scripts/audit-corpus.ts` | operator-safe | keep, but require explicit org context and include dedup/auth/runtime diagnostics |
| `scripts/migrate.ts` | operator-safe | migrate all discovered org DBs by default; support `--org <orgId>` and one-time `--adopt-history` for stale migration history |
| `scripts/pi-connect-subscription.ts` | machine-global helper | remains machine-global because inference credentials are not org-scoped |

## vNext CLI Direction

The target command surface is:

- `pnpm db:migrate`
- `pnpm db:migrate -- --org <orgId>`
- `pnpm db:migrate -- --all-orgs`
- `pnpm db:migrate -- --all-orgs --adopt-history`
- `pnpm db:reset --org <orgId> all`
- `pnpm db:reset --org <orgId> messages`
- `pnpm db:reset --org <orgId> jobs`
- `pnpm audit:corpus --org <orgId>`
- `pnpm reextract:bad-bodies --org <orgId>`
- `pnpm reextract:parse-errors --org <orgId>`
- `pnpm finance:import --org <orgId> <artifact.json>`
- `pnpm finance:dedupe-imports --org <orgId>`

## Cleanup Guarantees

- no duplicate artifact may contribute twice to rollups
- no one-off repair script may silently mutate another org runtime
- deprecated TanStack-specific scripts are removed once their owning stack is removed

## Out Of Scope

- hiding duplicate import repair inside unrelated schema migrations
