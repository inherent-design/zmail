# Jobs, Workers, and Observability

## Purpose

This document defines the background execution model for zmail vNext.

## Worker Topology

zmail runs one process-global worker supervisor.

The supervisor owns:

- discovery of org runtime roots
- startup of one worker loop per org runtime
- crash isolation between org runtimes

Each org runtime has:

- one org-local SQLite jobs table
- one org-local worker loop
- one org-local watcher registry

## Startup Rules

On process boot:

1. initialize logging
2. initialize Hono
3. start the worker supervisor
4. discover org runtime roots
5. lazily or eagerly start org-local worker loops

An org worker may also be started on first request or first CLI operation that
touches that org.

## Job Model

Jobs remain append-only operational records in the org-local DB.

Active job kinds:

- `sync_account_full`
- `sync_account_delta`
- `sync_account_backfill`
- `sync_account_reconcile`
- `classify_account_backlog`
- `classify_finance_backlog`
- `rebuild_category_assignments`
- `rebuild_finance_knowledge`
- `rebuild_finance_rollups`
- `reconcile_registry_suggestions`
- `import_finance_artifact`
- `rebuild_overseer`
- `import_operator_registry`

`scope_type = "system"` means system within one org DB, not machine-global.

## Lease and Claim Rules

- workers claim queued jobs FIFO inside one org DB
- claimed jobs receive a lease expiration time
- long-running jobs renew their lease heartbeat
- expired running jobs are requeued on org-worker startup
- queue idempotency applies within one org DB only

## Queue Idempotency Rules

Examples:

- root backlog: `(kind, scope_type=account, scope_id=accountId)`
- finance backlog: `(kind, scope_type=account, scope_id=accountId)`
- finance rollup rebuild: `(kind, scope_type=system, scope_id=finance_rollups)`
- finance import: `(kind, scope_type=system, scope_id=artifactSha256)`

The finance import queue scope must match the artifact dedup key:

- use `artifactSha256`
- do not use `sourceFile.sha256` as the idempotency scope

## Worker Boundaries

Hono handlers may:

- enqueue jobs
- read job state
- trigger org-worker startup

Hono handlers may not:

- execute full background workflows inline when a job contract exists
- bypass org runtime resolution

Workers may:

- load org-scoped services
- call Gmail/IMAP
- mutate org-local DB state
- write org-local files

## Startup Reconciliation

Every org-worker startup must perform reconciliation:

- requeue expired jobs
- restore watchers where applicable
- queue missing root backlog
- queue missing finance backlog
- queue missing deterministic projection rebuild
- queue finance knowledge rebuild only when upstream finance backlog is clear
- queue finance rollup rebuild only when knowledge is ready

## Observability Model

Logs are structured JSON with stable fields:

- `event`
- `operation`
- `trace_id`
- `request_id` when applicable
- `job_id` when applicable
- `org_id`
- optional `account_id`, `message_id`, `review_id`
- counts, outcomes, durations

Primary namespaces:

- `server.*`
- `job.*`
- `worker.*`
- `sync.*`
- `watcher.*`
- `auth.*`
- `oauth.*`
- `pi.*`
- `cli.*`

## Redaction Rules

Do not log:

- message bodies or snippets
- email addresses
- OAuth codes or tokens
- WorkOS tokens or cookies
- raw RFC822 paths when they reveal sensitive tenant structure beyond ids
- finance artifact contents

## Failure Modes

- one org-worker crash must not crash other org-workers
- one org DB corruption must fail that org runtime closed and surface a targeted
  operator error
- queue idempotency collisions are handled as expected duplicate outcomes, not
  fatal failures

## Out Of Scope

- cross-org shared jobs tables
- multi-process distributed worker coordination
- unaudited background mutation paths outside the jobs system
