# zmail vNext Spec Index

`docs/specs/` is the canonical architecture and contract surface for zmail vNext.

This spec set describes the target runtime:

- `Hono` as the API, auth, health, metrics, and WebSocket route owner
- `SvelteKit` as the browser page route and SSR owner
- `WorkOS` as the auth and organization plane
- per-org runtime roots under `data/orgs/<orgId>/...`
- authenticated WebSocket runtime-event invalidation for live browser UX

## Current Runtime Snapshot

This snapshot records the current implementation shape so near-term finance
close work keeps source, specs, and live operator state aligned.

Runtime shape:

- one Node process dispatches Hono API/auth/WebSocket routes and SvelteKit SSR
- in-process worker supervision starts one org-local worker loop per discovered
  org runtime
- each org stores jobs, messages, operator config, raw mail, derived finance
  state, and runtime events in its own SQLite/runtime root
- HTTP and RPC actions enqueue jobs; workers claim org-local lane-compatible
  jobs and publish durable runtime events that the browser receives over
  WebSocket

Pipeline shape:

- Gmail sync stores raw RFC822 source and normalized message rows
- moderation and root classification feed `finance-intel.v3`
- finance classification stages current heads for finance materialization
- review classification audits root reviews plus finance review/blocker ledger
  rows and may enqueue targeted root or finance reclassification jobs
- overseer profile rebuilds consume accepted review-classifier signals
- materialization/export/report jobs consume current heads and rebuild snapshots
- Beancount/Fava export and tax/business packages read staged ledger rows and
  count only strict-ready rows in accepted totals
- staged ledger rows need an exact `YYYY-MM-DD` Beancount date source before
  they can leave sidecars and enter exported ledger files

Count-only observation for live org `org_01KPADQ5W2MM1C5XNEAW6DFKJD` on
2026-04-20:

- `messages`: 41,482
- `finance_intel` heads: 2,044
- `finance_ledger_entries`: 526
- open root reviews: 62
- 2025 ledger rows: 388, all email-derived
- 2025 status: 345 `review`, 43 `blocked`, 0 `ready`
- `finance_account_mappings`: 0
- mapping gaps: 585
- imported finance artifacts: 0 runs, 0 documents, 0 transactions
- export runs: 0

Strict Beancount export currently has no meaningful 2025 entries to export
because the exporter writes only `ready` rows, and all current 2025 rows lack
resolved account mappings.

## Near-Term Finance Close Focus

The active finance close workstream is:

- 2025 classification and readiness audit
- Beancount/Fava export readiness
- annual personal tax workpapers
- quarterly inherent.design business workpapers
- purpose-first book semantics for business items paid through personal
  accounts

Purpose-first means book scope follows the transaction purpose. Business-purpose
rows paid through personal accounts may be `business`; ambiguous shared-use rows
are `mixed` only when explicit allocation metadata is present.

## What Is Authoritative

The following rules are mandatory:

- files under `docs/specs/` are the only active architecture truth
- when source and spec disagree, implementation must move toward the spec unless
  the spec is explicitly corrected in the same change
- `README.md`, `CONTRIBUTING.md`, and `docs/testing/*` are secondary entrypoints
  and must defer to this tree for product/runtime contracts
- implementation work must update the owning spec in the same change whenever a
  public contract, storage rule, auth rule, or operator workflow changes

## What Is Archived

zmail does not keep stale active architecture notes in place.

- old TanStack Start, single-tenant, and transition-era docs have been removed
  from the active tree
- if historical docs are retained in the future, they belong outside
  `docs/specs/` and are non-authoritative by definition
- roadmap intent that still matters lives in
  [future-boundaries.md](./future-boundaries.md), not in free-form legacy notes

## Reading Order

1. [system-overview.md](./system-overview.md)
2. platform specs
3. domain specs
4. operations specs
5. [future-boundaries.md](./future-boundaries.md)

## Spec Ownership By Subsystem

| Subsystem | Owning Spec | Expected Source Families |
| --- | --- | --- |
| System topology | [system-overview.md](./system-overview.md) | `server/**`, `src/**`, `lib/**`, `scripts/**` |
| Hono server/runtime | [platform/hono-application.md](./platform/hono-application.md) | `server/app.ts`, `server/http.ts`, `server/realtime-ws.ts`, `server/actions.ts`, `server/auth.ts`, `server/machine-auth.ts` |
| Internal application taxonomy | [platform/internal-application-taxonomy.md](./platform/internal-application-taxonomy.md) | `server/actions.ts`, `server/auth.ts`, `lib/**`, transport/domain boundaries |
| SvelteKit UI | [platform/sveltekit-ui.md](./platform/sveltekit-ui.md) | `src/**`, `public/assets/**`, `lib/client-contract.ts` |
| Auth and organizations | [platform/auth-and-organizations.md](./platform/auth-and-organizations.md) | `server/auth.ts`, `server/machine-auth.ts`, `lib/runtime.ts` |
| Runtime storage and org tenancy | [platform/runtime-storage-and-tenancy.md](./platform/runtime-storage-and-tenancy.md) | `lib/runtime.ts`, `lib/db.ts`, `scripts/db-*` |
| Jobs, workers, observability | [platform/jobs-workers-and-observability.md](./platform/jobs-workers-and-observability.md) | `lib/jobs.ts`, `lib/worker.ts`, `lib/log.ts` |
| Gmail sync and ingestion | [domain/gmail-sync-and-ingestion.md](./domain/gmail-sync-and-ingestion.md) | `lib/google-oauth.ts`, `lib/sync.ts`, `lib/watchers.ts`, `lib/imap.ts` |
| Message model | [domain/message-model.md](./domain/message-model.md) | `lib/db.ts`, `lib/schemas.ts`, `lib/sync.ts` |
| Moderation and root classification | [domain/moderation-and-root-classification.md](./domain/moderation-and-root-classification.md) | `lib/moderation.ts`, `lib/classify.ts`, `prompts/` |
| Secondary classifiers and projections | [domain/secondary-classifiers-and-projections.md](./domain/secondary-classifiers-and-projections.md) | `lib/secondary.ts`, `lib/finance-intel.ts`, `lib/category-rules.ts` |
| Operator registry and taxonomy | [domain/operator-registry-and-taxonomy.md](./domain/operator-registry-and-taxonomy.md) | `lib/registry.ts`, `data/orgs/<orgId>/operator/**` |
| Finance imports | [domain/finance-imports.md](./domain/finance-imports.md) | `lib/finance-imports.ts`, `scripts/import-finance-artifact.ts`, `scripts/submit_finance_artifact.py` |
| Finance knowledge and rollups | [domain/finance-knowledge-and-rollups.md](./domain/finance-knowledge-and-rollups.md) | `lib/finance-knowledge.ts`, `lib/finance-rollups.ts` |
| Beancount and Fava export | [domain/beancount-fava-export.md](./domain/beancount-fava-export.md) | `lib/finance-rollups.ts`, `scripts/export-finance-beancount.ts` |
| Tax and business reporting | [domain/tax-and-business-reporting.md](./domain/tax-and-business-reporting.md) | `lib/finance-knowledge.ts`, `lib/finance-rollups.ts`, future report export services |
| Migrations and scripts | [operations/migrations-cleanups-and-one-off-scripts.md](./operations/migrations-cleanups-and-one-off-scripts.md) | `db/migrations/**`, `scripts/**` |
| Testing and proof | [operations/testing-and-proof.md](./operations/testing-and-proof.md) | `test/**`, CI commands, manual smoke docs |
| Security and secrets | [operations/security-and-secrets.md](./operations/security-and-secrets.md) | `lib/log.ts`, auth config, secret loading, `.gitignore` |
| Architecture decisions | [platform/adr-002-sveltekit-ui-and-hono-websocket.md](./platform/adr-002-sveltekit-ui-and-hono-websocket.md) | platform-level decision records |

## How Implementation Should Track Spec Drift

Use this rule set:

- if source is wider than the spec and the behavior belongs in vNext, extend the
  spec first or in the same change
- if the spec is wider than source and the contract is still desired, source is
  behind and must be reimplemented or upgraded
- do not preserve current-stack wiring as active truth merely because it exists
  in source today
- do not let ad hoc scripts or test fixtures define public contracts

## Non-Goals For This Tree

- documenting deprecated TanStack Start/router/server-action wiring as active
  architecture
- preserving a transitional `app/**` runtime layer after the purge
- preserving single-tenant runtime assumptions as forward contracts
- leaving finance import safety, org tenancy, or auth boundaries implicit

## Unified Workflow Refresh

Browser workflows use a shared mutation envelope for JSON RPC and multipart
forms. Route handlers may return `toast`, `redirectTo`, `invalidate`, job hints,
and event hints while preserving the existing `{ ok: true, status }` shape.

SvelteKit loads declare `depends(...)` invalidation keys. The browser receives
durable runtime events over `/ws` and maps topics to invalidation keys instead
of requesting main, island, or node fragments.
