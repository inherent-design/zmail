# Internal Application Taxonomy

## Purpose

This document defines the minimal internal naming and safety contract for zmail
vNext application code.

It exists to make the current server/runtime surface easier to read, map, and
refactor without forcing a broad rewrite in the same change.

## Scope

Covered here:

- canonical internal taxonomy
- auth-plane distinction
- compile-time and runtime safety rules
- current implementation drift
- near-term target direction

Not covered here:

- route renaming
- framework replacement
- large-scale file moves in the same pass
- UI design or page structure

## Canonical Internal Taxonomy

Use these terms as the primary internal organizing model:

- `queries`
  - read-oriented application operations
  - may perform required bootstrap or initialization reads
  - do not intentionally mutate user-visible domain state
- `commands`
  - state-changing application operations
  - may mutate DB state, write provider credentials, enqueue jobs, or emit
    runtime events
- `domain services`
  - business/domain logic reusable across transport surfaces
  - must not depend on Hono request/response objects
  - must not depend on JSX rendering concerns

These terms are preferred over generic infrastructure-first labels such as:

- `manager`
- `provider manager`
- `server manager`
- catch-all `service` where the role is otherwise unclear

## Non-Goals For This Contract Pass

- no new manager layer
- no broad abstraction scaffolding before concrete reuse exists
- no public route redesign
- no repo-wide split of `server/actions.ts` in this patch

## Transport Ownership

Current transport ownership stays unchanged:

- `server/index.tsx`
  - Hono route registration
  - middleware composition
  - transport-level validation and response shaping
- `server/auth.ts`
  - WorkOS browser auth
  - organization selection and session/org boundary enforcement
- `server/actions.ts`
  - current mixed application surface for reads and mutations

The current code is valid, but its internal naming is not yet the desired final
map.

## Auth Planes

zmail has two intentional authentication or OAuth planes.

### Session auth plane

Owned by WorkOS browser session concerns:

- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`

This plane establishes operator identity, session cookies, active org
selection, and browser access to protected routes.

### Provider account-linking plane

Owned by mailbox/provider credential acquisition:

- `POST /rpc/accounts/connect/google`
- `GET /oauth/google/callback`
- `POST /rpc/accounts/:accountId/reconnect`
- reconnect flows for Gmail account authorization

This plane acquires mailbox-provider credentials for an already authenticated
operator within an org context.

These planes are intentionally separate even though both involve OAuth-style
redirects.

## Safety Contract

Safety is defined in three layers.

### Compile-time safety

- exported application surfaces must have explicit TypeScript input/output types
- no `any` on public module boundaries
- route handlers, commands, queries, worker entrypoints, and integration
  adapters must expose concrete types

### Boundary validation safety

Use Zod or equivalent schema validation at external and persistence boundaries:

- HTTP query, form, and JSON inputs
- OAuth callback/query inputs
- file ingestion and artifact parsing
- external provider payloads entering the app
- persisted JSON encode/decode boundaries
- job meta decode boundaries where data crosses runtime time/process boundaries

Do not require indiscriminate schema wrapping for every internal function call.

### Runtime and effect safety

Business/domain logic must not silently assume deterministic success from
effectful boundaries.

Treat these as explicit non-deterministic domains:

- external auth providers
- Gmail/IMAP/provider APIs
- filesystem access
- DB read/write races
- background job scheduling and duplicate-open-job behavior
- retry flows and worker leases
- time-based state transitions
- network failures and malformed external payloads

Effectful adapters should either:

- return explicit success/failure shapes, or
- throw typed or normalized errors at a defined boundary

## Current Implementation Drift

Current source shape:

- `server/actions.ts` mixes:
  - reads
  - mutations
  - bootstrap
  - queue orchestration
  - some domain-adjacent logic
- naming is mostly workable but not yet contractually ordered
- route surface is healthy but not yet mirrored by a concise internal map

This drift is acceptable in the short term and does not block runtime
correctness.

## Target Direction

Later refactors should move incrementally toward:

- `server/queries/*`
- `server/commands/*`
- `lib/domain/*` or equivalent minimal domain-service grouping
- thin transport adapters in `server/index.tsx`

That direction is intentional, but this document does not require the split in
the same change that introduces the contract.
