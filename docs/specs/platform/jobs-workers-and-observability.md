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
- bounded concurrent job execution across compatible per-org lanes

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
- `classify_root_messages`
- `classify_finance_backlog`
- `classify_finance_messages`
- `classify_review_backlog`
- `rebuild_category_assignments`
- `rebuild_finance_knowledge`
- `rebuild_finance_rollups`
- `reconcile_registry_suggestions`
- `import_finance_artifact`
- `export_finance_beancount`
- `generate_tax_personal_package`
- `generate_tax_business_quarter_package`
- `generate_finance_mapping_candidates`
- `rebuild_overseer`
- `import_operator_registry`

`scope_type = "system"` means system within one org DB, not machine-global.

Job rows include scheduling and lane metadata:

- `lane`
- `priority`
- `run_after_at`
- `claim_owner`

Lane mapping:

- `sync`: Gmail full/delta/backfill/reconcile
- `root_llm`: root backlog and targeted root message classification
- `finance_llm`: finance backlog and targeted finance message classification
- `review_llm`: review classifier backlog
- `materialize`: registry import, registry suggestion reconcile, category
  assignments, finance knowledge, and finance rollups
- `export_report`: Beancount export and tax/business package generation
- `overseer`: overseer profile rebuild and finance mapping candidate generation

Default worker config:

- `worker.max_job_concurrency = 8`
- default lane caps: sync `2`, root LLM `2`, finance LLM `2`, review LLM
  `1`, materialize `2`, export/report `1`, overseer `1`
- total cap is enforced per org worker
- SQLite remains one DB per org with WAL and short write transactions

## Lease and Claim Rules

- workers claim queued jobs inside one SQLite transaction
- candidate order is `priority asc, created_at asc`
- claim selection must fetch bounded candidates per lane before sorting
  compatible candidates, so a saturated root backlog cannot hide materialize,
  export/report, or overseer work
- claimed jobs receive a lease expiration time
- long-running jobs renew their lease heartbeat
- expired running jobs are requeued on org-worker startup
- queue idempotency applies within one org DB only
- a worker must not claim a queued job when the lane cap is full
- a worker must not claim a queued job when any running job holds an
  incompatible resource lock

Static resource locks:

- sync jobs: `sync:<accountId>`
- root LLM jobs: `root:<accountId>`
- finance LLM jobs: `finance:<accountId>`
- review LLM jobs: `review:<accountId>`
- finance materialization: `finance:materialize`
- export/report jobs: `finance:export-report`
- finance mapping candidates: `finance:mapping-candidates`
- overseer rebuilds: `overseer:<accountId>`

Materialization may run while LLM jobs run. It must record an input watermark at
start and requeue itself when upstream heads or review findings change before
finish.

Export/report jobs may run while upstream work exists, but packages must mark
stale or audit-only when open jobs can change accepted totals.

## Queue Idempotency Rules

Examples:

- root backlog: `(kind, scope_type=account, scope_id=accountId)`
- finance backlog: `(kind, scope_type=account, scope_id=accountId)`
- targeted finance repair extraction:
  `(kind=classify_finance_messages, scope_type=account, scope_id=accountId)`
  with `meta.targetMessageIds`
- targeted root repair classification:
  `(kind=classify_root_messages, scope_type=account, scope_id=accountId)` with
  `meta.targetMessageIds`
- review classifier:
  `(kind=classify_review_backlog, scope_type=account|system, scope_id=...)`
- finance rollup rebuild: `(kind, scope_type=system, scope_id=finance_rollups)`
- finance import: `(kind, scope_type=system, scope_id=artifactSha256)`
- finance export: `(kind=export_finance_beancount, scope_type=system, scope_id=exportRunId)`
- tax/report package:
  `(kind=generate_tax_*_package, scope_type=system, scope_id=taxReportRunId)`
- finance mapping candidates:
  `(kind=generate_finance_mapping_candidates, scope_type=system, scope_id=finance_mapping_candidates)`

Completed finance knowledge rebuilds queue finance mapping candidate generation
when the materialized ledger snapshot has `review` or `blocked` rows. The
mapping job records `meta.inputWatermark`, `meta.outputWatermark`,
`meta.requeuedForChangedInputs`, and `meta.source`. If mapping inputs change
during generation, the worker queues one trailing idempotent mapping job with
the same system scope.

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

## Job Event Target Hints

Job events may include redacted change hints for SvelteKit invalidation. Hints
carry topic, event type, and entity id only. Workers do not read DOM contracts;
event producers attach neutral entity ids and page modules translate those ids
to invalidation keys when needed.
