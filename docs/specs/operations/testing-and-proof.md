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
- registry and projection helpers
- import dedup helpers
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
- Gmail sync and cursor transitions

### Browser E2E

Own:

- authenticated org login flow
- org selection
- Gmail connect/reconnect/disconnect/delete UX
- review resolution
- finance page filters and warning states
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
| Finance import dedup | unit + integration |
| Finance rollups | unit + integration |
| Repair scripts | integration |
| Legacy runtime claim | integration + manual smoke |

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
