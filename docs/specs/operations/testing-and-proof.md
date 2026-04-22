# Testing and Proof

## Purpose

This document defines how zmail vNext proves correctness and guards against
spec/source drift.

## Proof Philosophy

Use the cheapest deterministic proof layer that can validate the behavior.

Priority:

1. unit tests
2. integration tests
3. browser e2e
4. manual smoke

Do not rely on live browser tests as the only proof for behavior that can be
validated cheaper.

The legacy TanStack route/component unit suite is not part of the active proof
model. Route correctness is now owned by Hono integration tests plus Playwright
coverage for interactive flows.

The canonical test commands use `mise`. `pnpm raw:*` scripts are implementation
details used by mise tasks.

- `mise run test` runs the quick local gate: lint, typecheck, unit, and
  integration
- `mise run test:quick` is the explicit name for the same quick local gate
- `mise run test:coverage` runs the full gate: lint, typecheck, covered unit
  buckets, integration, browser e2e, fuzz, and stress
- `mise run test:unit` runs all unit buckets
- `mise run test:unit -- <domain>` runs unit buckets for one domain, such as
  `platform`, `domain`, `finance`, or `runtime`
- `mise run test:integration` runs all integration tests
- `mise run test:e2e` runs the Playwright browser harness
- `mise run test:fuzz` runs property and fuzz checks
- `mise run test:stress` runs stress checks with a suite-managed temporary
  server
- `mise run test:list` prints the current suite catalog

`mise run test:coverage` is the CI and release gate. It does not duplicate
Vitest by running both covered and non-covered unit passes. Integration remains
tests-only inside the coverage gate until stable integration coverage ownership
exists. Benchmarks are explicit and are not part of `test:coverage`.

## Required Test Layers

### Unit

Own:

- runtime config resolution and validation
- callback URL derivation
- schema normalization
- moderation freshness helpers
- root and finance classification helpers
- review classifier schema, persistence, and action dispatch helpers
- registry and projection helpers
- import dedup helpers
- job lane claiming, compatibility locks, lease expiry, and idempotency
- tax package accepted-total and unsafe-evidence helpers
- auth/org principal parsing helpers

### Integration

Own:

- Hono route behavior
- Hono page rendering and partial-navigation headers
- `base_path` route mounting
- org runtime resolution
- SQLite persistence
- jobs and worker orchestration
- finance import dedup and cleanup
- finance loader math
- review classifier worker jobs and targeted reclassification queues
- mapping editor YAML write, registry import queue, and finance rebuild queue
- materialization snapshot requeue when upstream heads/reviews change
- Beancount export and tax package persistence
- Gmail sync and cursor transitions

### Browser E2E

Own:

- authenticated org login flow
- org selection
- Gmail connect/reconnect/disconnect/delete UX
- review resolution
- review classifier findings and action history
- finance page filters and warning states
- finance readiness, mapping editor, export, and tax package flows
- runs page concurrent lane status
- local account deletion flows

### Manual Smoke

Own:

- real WorkOS browser auth
- real Gmail OAuth
- real IMAP behavior
- machine-token finance import
- multi-org runtime isolation sanity checks

## Spec Verification Matrix

| Area | Minimum proof |
| --- | --- |
| Hono route/auth boundary | integration |
| Hono JSX page and enhanced MPA contract | browser e2e |
| WorkOS org/role enforcement | integration + manual smoke |
| Gmail sync lifecycle | unit + integration + manual smoke |
| Moderation/root freshness | unit + integration |
| Review classifier persistence/action dispatch | unit + integration + browser e2e |
| Finance import dedup | unit + integration |
| Finance rollups | unit + integration |
| Worker lane scheduler | unit + integration |
| Beancount export and tax packages | unit + integration + browser e2e |
| Repair scripts | integration |
| Legacy runtime claim | integration + manual smoke |

## Finance Close Verification Matrix

Must cover:

- job claim concurrency across compatible lanes
- same-resource exclusion for sync/root/finance/review/materialize/export locks
- lease expiry requeues with cleared claim owner
- duplicate idempotent queue requests return the same open job
- root, finance, review, materialize, export, and report jobs interleave without
  corrupting one org SQLite DB
- review classifier JSON schema parse, result persistence, current-head upsert,
  targeted reclassification dispatch, and no direct label/mapping mutation
- overseer input consumes recent review classifier heads
- mapping editor writes YAML, imports registry, marks finance heads stale, and
  queues finance knowledge/rollup rebuilds
- tax packages generate no-ready audit packages, count only ready rows in
  accepted totals, and omit raw RFC822 bodies, tokens, secrets, and full account
  numbers
- Beancount export excludes `review`, `blocked`, `duplicate`, and non-export
  directions
- `/runs`, `/review`, and `/finance` browser flows show lane status, findings,
  readiness/mapping/export/tax state

## Import Dedup Test Matrix

Must cover:

- duplicate exact artifact returns `already_imported`
- duplicate exact artifact does not enqueue a second job
- duplicate exact artifact does not create a second run row
- same source file with a different artifact hash is allowed
- rollups count each unique artifact exactly once
- cleanup script removes historical duplicates safely

## Auth and Organization Test Matrix

Must cover:

- unauthenticated browser request
- authenticated browser request with no active org
- viewer attempting operator action
- operator importing finance artifact through browser session
- machine token import with matching `org_id`
- machine token import with wrong or missing `org_id`
- org runtime isolation between two org roots
- strict local boot failing when required WorkOS browser env is missing
- native `mise` loading from `secrets.enc.yaml` for server-side tasks

## Runtime Config Test Matrix

Must cover:

- default config from checked-in `zmail.toml`
- environment overrides winning over `zmail.toml`
- invalid `public_origin` rejection
- invalid `base_path` rejection
- derived WorkOS callback from `public_origin + base_path`
- derived Google OAuth callback from `public_origin + base_path`
- explicit callback override envs taking precedence
- legacy `PORT` and `RUN_WORKER` fallback env behavior

## Drift Checks

Spec/source drift checks must be part of review:

- active docs under `docs/specs/` are the only target-truth architecture docs
- no active spec claims TanStack Start/router/server actions as the target stack
- no active spec claims single-tenant `data/` as the forward runtime shape
- source changes that widen or narrow public contracts update the owning spec

## Documentation Maintenance Rules

- a change that alters a public contract must update docs in the same PR
- a change that retires a script, route, or migration policy must update the
  owning operations spec
- a change that introduces a new external API or auth flow must update the
  platform specs first or in the same PR

## Out Of Scope

- coverage targets as a substitute for behavioral proof
- browser-only proof for server/auth/data-integrity contracts

## Unified Workflow Proof

Unit tests cover source-kind normalization, artifact hash fallback, UI target
normalization, node token handling, mutation parsing, multipart submission, and
DataInspector state. Integration tests cover compatible envelopes for touched
RPC routes, finance import legacy `statement` input, node partial headers, and
ledger override persistence. Browser tests cover account actions, message
classification, review decisions, finance upload source filters, node refresh,
and DataInspector state preservation.
