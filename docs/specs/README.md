# zmail vNext Spec Index

`docs/specs/` is the canonical architecture and contract surface for zmail vNext.

This spec set describes the target runtime:

- `Hono` as the sole HTTP server and route owner
- `Hono JSX` as the sole HTML rendering layer
- `WorkOS` as the auth and organization plane
- per-org runtime roots under `data/orgs/<orgId>/...`
- authenticated SSE plus enhanced MPA navigation for live browser UX

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
| System topology | [system-overview.md](./system-overview.md) | `server/**`, `public/client/**`, `lib/**`, `scripts/**` |
| Hono server/runtime | [platform/hono-application.md](./platform/hono-application.md) | `server/index.tsx`, `server/actions.ts`, `server/auth.ts`, `server/machine-auth.ts` |
| Internal application taxonomy | [platform/internal-application-taxonomy.md](./platform/internal-application-taxonomy.md) | `server/actions.ts`, `server/auth.ts`, `lib/**`, transport/domain boundaries |
| Hono JSX UI | [platform/hono-jsx-ui.md](./platform/hono-jsx-ui.md) | `server/ui.tsx`, `public/client/**`, `public/assets/**` |
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
| Migrations and scripts | [operations/migrations-cleanups-and-one-off-scripts.md](./operations/migrations-cleanups-and-one-off-scripts.md) | `db/migrations/**`, `scripts/**` |
| Testing and proof | [operations/testing-and-proof.md](./operations/testing-and-proof.md) | `test/**`, CI commands, manual smoke docs |
| Security and secrets | [operations/security-and-secrets.md](./operations/security-and-secrets.md) | `lib/log.ts`, auth config, secret loading, `.gitignore` |
| Architecture decisions | [platform/adr-001-hono-jsx-over-ripple.md](./platform/adr-001-hono-jsx-over-ripple.md) | platform-level decision records |

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
