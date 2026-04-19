# System Overview

## Purpose

This document defines the product-level architecture for zmail vNext.

It is the root overview for the Hono + Hono JSX + WorkOS + per-org runtime
model.

## Product Summary

zmail is a local-first Gmail corpus mirror and analysis system.

Core product responsibilities:

- authenticate operators through WorkOS
- scope every request and runtime to one organization
- connect Gmail accounts through Google OAuth
- mirror `[Gmail]/All Mail` into an org-local SQLite corpus
- store raw RFC822 and operator config under the org runtime root
- run moderation, root classification, secondary finance classification,
  deterministic projections, and finance materialization over that corpus
- accept external finance artifacts from authenticated users or org-scoped
  machine clients

## Major Subsystems

### Platform

- Hono HTTP server
- Hono JSX SSR plus `hono/jsx/dom` islands
- authenticated SSE event streaming
- enhanced MPA browser navigation
- WorkOS AuthKit browser auth
- WorkOS M2M automation auth
- per-org runtime resolution

### Messaging and sync

- Gmail OAuth credential storage
- IMAP bootstrap, delta, backfill, reconcile, watcher lifecycle
- raw RFC822 persistence
- parsed message normalization

### Intelligence

- moderation
- root classification via `message-label.v3`
- finance secondary classification via `finance-intel.v3`
- deterministic category projection
- overseer/profile generation

### Finance knowledge

- finance artifact import and deduplication
- registry suggestions and reconciliation
- finance knowledge candidate materialization
- yearly finance rollups and filtered ledger views

### Operations

- org-local migrations
- repair and re-extraction scripts
- worker supervision
- structured logging and proof layers

## Runtime Topology

zmail is a single application process with multiple org-local runtimes.

Topology rules:

- one Hono server process owns all HTTP traffic
- one process-global worker supervisor discovers and manages org-local worker
  loops
- each organization resolves to one runtime root and one SQLite database
- each org runtime owns its own Gmail account storage, raw email storage,
  operator config, jobs, and materialized state
- there is no shared row-level multitenancy inside a single corpus database

## First Hosted Deployment

The first hosted deployment contract is intentionally narrow:

- one public route at `zmail.inherent.design`
- no Cloudflare Access interstitial; authentication stays inside zmail through
  WorkOS
- one application process handles HTTP and the worker with `RUN_WORKER=true`
- one single-node persistent volume is mounted as `ZMAIL_DATA_DIR`
- the mounted data root must hold `orgs/<orgId>/...`
- WorkOS browser bootstrap and Google OAuth bootstrap env are required
- WorkOS M2M bootstrap env is optional and only required when machine-token
  finance import automation is enabled

## Organization Boundary

The organization is the primary tenancy boundary.

The boundary applies to:

- browser sessions
- machine tokens
- database selection
- account storage
- raw RFC822 files
- operator registry/taxonomy YAML
- worker execution and watcher ownership

Cross-org reads or writes are forbidden.

## External Systems

### WorkOS

- AuthKit for browser user sessions
- organizations and memberships
- org-scoped roles and permissions in session tokens
- machine-to-machine tokens for automation

### Google OAuth

- Gmail account authorization and refresh tokens
- account-scoped provider credentials stored in the org runtime root

### Gmail IMAP

- mailbox sync via `imapflow`
- `[Gmail]/All Mail` as the only mirrored mailbox

### `pi-ai`

- moderation
- root classification
- finance intelligence
- overseer/profile generation

### External finance extractors

- Python or other external tools produce `finance-source-import.v1`
  artifacts
- authenticated HTTP import or org-aware CLI import submits those artifacts

## Request and Data Flows

### Browser operator flow

1. user authenticates with WorkOS
2. Hono resolves `org_id` and role/permissions
3. org runtime root and org DB are selected
4. Hono JSX renders the page with org-scoped data
5. browser mutations submit to Hono RPC or authenticated JSON endpoints
6. live page state follows org-scoped SSE events

### Gmail connect and sync flow

1. authenticated operator starts Gmail connect or reconnect
2. Google OAuth callback writes provider tokens into the org runtime
3. org-local worker queues bootstrap sync
4. sync persists raw RFC822 and normalized message rows
5. backlog classification and secondary finance work follow ingestion

### Finance import flow

1. authenticated browser user or org M2M client sends artifact
2. Hono validates auth, org context, JSON, and artifact schema
3. import dedup checks `artifactSha256`
4. new artifact is queued or imported once
5. registry suggestion reconciliation and finance rollup rebuild follow import

## Invariants

- every request touching operator data resolves an organization before DB access
- every org runtime is isolated on disk and in SQLite
- finance import dedup is artifact-based, not source-file-based
- public API behavior is explicit and structured, never implicit through thrown
  exceptions
- active specs describe target architecture even when source still lags

## Out Of Scope

- send, compose, delete, or label-write behavior against Gmail
- shared-database row-scoped multitenancy
- open unauthenticated HTTP APIs
- manual finance candidate adjudication in the first vNext contract
