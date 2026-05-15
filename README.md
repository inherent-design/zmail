# zmail

zmail is a local-first Gmail corpus mirror and analysis system.

The canonical architecture and contract surface for the in-progress refactor
lives under [`docs/specs/`](./docs/specs/README.md).

## Canonical Docs

Read these first:

- [Spec index](./docs/specs/README.md)
- [System overview](./docs/specs/system-overview.md)
- [Hono application](./docs/specs/platform/hono-application.md)
- [SvelteKit UI](./docs/specs/platform/sveltekit-ui.md)
- [ADR 002: SvelteKit UI and Hono WebSocket](./docs/specs/platform/adr-002-sveltekit-ui-and-hono-websocket.md)
- [Auth and organizations](./docs/specs/platform/auth-and-organizations.md)
- [Runtime storage and tenancy](./docs/specs/platform/runtime-storage-and-tenancy.md)
- [Gmail sync and ingestion](./docs/specs/domain/gmail-sync-and-ingestion.md)
- [Finance imports](./docs/specs/domain/finance-imports.md)
- [Finance knowledge and rollups](./docs/specs/domain/finance-knowledge-and-rollups.md)
- [Observability](./docs/specs/operations/observability.md)
- [Migrations, cleanups, and scripts](./docs/specs/operations/migrations-cleanups-and-one-off-scripts.md)

## Requirements

zmail intentionally does not pin every system CLI in local `mise.toml`.
Project-local `mise` tasks are the canonical command surface, but some binaries
remain machine-level dependencies.

Required for local development:

- Node 24+
- pnpm
- sops + age for `secrets.enc.yaml`

Required for finance PDF/ZIP upload processing:

- Poppler command-line tools:
  - `pdfinfo`
  - `pdftotext`
  - `pdftoppm`
- `VOYAGE_API_KEY` when uploads use `voyage_gate` or `auto` routes scanned or
  layout-heavy PDFs through Voyage multimodal embeddings

Required for full finance export/Fava workflows:

- Beancount CLI:
  - `bean-check`
- Fava CLI:
  - `fava`
- uv, used as a fallback launcher for Fava when `fava` is not already on PATH

Optional local observability:

- Docker CLI
- Docker Compose

## vNext Architecture

The target runtime is:

- one Node process with Hono dispatching API/auth/WebSocket routes first
- `SvelteKit` as the browser page renderer and SSR owner
- `WorkOS` as the auth and organization plane
- per-org runtime roots under `data/orgs/<orgId>/...`
- authenticated WebSocket runtime event delivery
- authenticated, artifact-idempotent finance imports

The legacy TanStack route/component tree and Hono JSX browser UI have been
purged. Live runtime ownership now sits under:

- `server/**`
- `src/**`
- `lib/**`
- `scripts/**`

When source and spec disagree, the spec is the target contract unless corrected
in the same change.

## Hosted Deployment Contract

The first hosted deployment stays intentionally narrow:

- public route: `zmail.inherent.design`
- canonical hosted WorkOS callback:
  - `https://zmail.inherent.design/auth/callback`
- no Cloudflare Access interstitial; WorkOS auth happens inside the app
- one Node 24 process runs HTTP and the worker together
- one mounted runtime root is provided through `ZMAIL_DATA_DIR`
- runtime state stays under `data/orgs/<orgId>/...` beneath that root

The services stack supplies this bootstrap env set:

- required:
  - `ZMAIL_PUBLIC_ORIGIN`
  - `WORKOS_API_KEY`
  - `WORKOS_CLIENT_ID`
  - `WORKOS_COOKIE_PASSWORD`
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
- optional:
  - `ZMAIL_BASE_PATH`
  - `WORKOS_REDIRECT_URI`
  - `GOOGLE_OAUTH_REDIRECT_URL`
  - `WORKOS_M2M_CLIENT_ID`
  - `WORKOS_M2M_CLIENT_SECRET`
  - only needed when machine-token finance import automation is enabled

`VOYAGE_API_KEY` is required in the runtime environment when hosted finance
uploads use Voyage multimodal page selection. Other inference credentials such
as `OPENAI_API_KEY` and `data/openai-subscription.json` remain separate from
the hosted bootstrap contract.

The repo now includes a Node 24 container build in [`Dockerfile`](./Dockerfile)
and keeps the runtime entrypoint equivalent to:

```bash
pnpm build
pnpm raw:preview
```

## Runtime Config

Non-secret runtime defaults live in [`zmail.toml`](./zmail.toml).

Resolution order is:

1. environment variables
2. `zmail.toml`
3. built-in defaults

Example local overrides live in [`.env.example`](./.env.example).

Canonical local defaults:

- `ZMAIL_PUBLIC_ORIGIN=http://127.0.0.1:56711`
- `ZMAIL_BASE_PATH=/`
- derived WorkOS callback:
  - `http://127.0.0.1:56711/auth/callback`
- derived Google OAuth callback:
  - `http://127.0.0.1:56711/oauth/google/callback`

If you want local development on `localhost`, override
`ZMAIL_PUBLIC_ORIGIN=http://localhost:56711`.

Local startup with repo-managed bootstrap secrets uses `mise run dev`. Plain
`pnpm raw:dev` is the raw runtime entrypoint and does not load
`secrets.enc.yaml`.

Local observability is optional and disabled by default. To run with Prometheus
metrics and a Loki-tailored JSON log file:

```bash
mise run dev:obs
```

Start the local Grafana, Loki, Prometheus, and Alloy stack before the
observability-enabled app when you want dashboards and log ingestion:

```bash
mise run obs:up
mise run dev:obs
```

Grafana is available at `http://127.0.0.1:3000`.

The shared local WorkOS bootstrap contract is:

- required browser/session bootstrap:
  - `WORKOS_API_KEY`
  - `WORKOS_CLIENT_ID`
  - `WORKOS_COOKIE_PASSWORD`
- optional machine-token bootstrap for finance import automation:
  - `WORKOS_M2M_CLIENT_ID`
  - `WORKOS_M2M_CLIENT_SECRET`

Shared local secrets should rely on derived callback behavior from
`ZMAIL_PUBLIC_ORIGIN` and should not carry the default local
`WORKOS_REDIRECT_URI`.

Deployment and runtime env ownership stays under:

- `~/production/inherent.design/platform/services`

## Repo Scope

Active product scope:

- Gmail OAuth connect and reconnect
- IMAP sync of `[Gmail]/All Mail`
- org-scoped local SQLite corpus
- moderation, root classification, finance secondary classification
- deterministic category projection
- finance artifact import, registry suggestion reconciliation, and rollups

Not in the active scope:

- sending or mutating Gmail state
- open unauthenticated APIs
- shared row-level multitenancy inside one DB

## Transitional Local Commands

The repository still ships current implementation scripts while the rewrite is
underway. Treat them as transitional tooling, not architecture truth.

```bash
mise run dev
mise run dev:obs
mise run test
mise run test:quick
mise run test:coverage
mise run test:unit
mise run test:unit -- finance
mise run test:integration
mise run test:e2e
mise run test:fuzz
mise run test:stress
mise run test:list
mise run db:migrate
pnpm db:reset
pnpm db:reset:messages
pnpm db:reset:jobs
mise run audit:corpus
pnpm reextract:parse-errors
pnpm reextract:bad-bodies
mise run finance:import
mise run obs:up
mise run obs:down
mise run worker:drain
pnpm pi:connect
mise run bench:http
mise run bench:ws
```

Use `mise run dev` when you expect repo-managed WorkOS or Google bootstrap
secrets to be loaded for local development. Do not expect plain
`pnpm raw:dev` to load `secrets.enc.yaml`.

Use `mise` as the canonical test interface. `pnpm raw:*` scripts are
implementation details used by mise tasks. `mise run test` runs the quick local
gate: lint, typecheck, unit, and integration. `mise run test:coverage` runs the
full gate: lint, typecheck, covered unit buckets, integration, browser e2e,
fuzz, and stress. Benchmarks are explicit and are not part of the coverage
gate.

The target command model is documented in:

- [operations/migrations-cleanups-and-one-off-scripts.md](./docs/specs/operations/migrations-cleanups-and-one-off-scripts.md)

## Runtime State

All local runtime state belongs under `data/` and must stay out of git.

The target tenancy layout is documented in:

- [runtime-storage-and-tenancy.md](./docs/specs/platform/runtime-storage-and-tenancy.md)

## Testing

Testing expectations are defined in:

- [operations/testing-and-proof.md](./docs/specs/operations/testing-and-proof.md)
- [manual smoke](./docs/testing/gmail-live-sync-manual-smoke.md)

## Security

Security and secret handling are defined in:

- [operations/security-and-secrets.md](./docs/specs/operations/security-and-secrets.md)

Repo-managed bootstrap secrets live in `secrets.enc.yaml` and are loaded into
server-side task env through native `mise` loading. Hosted deployments receive
the same values through orchestration/runtime env injection.

`WORKOS_CLIENT_SECRET` is not part of the current zmail runtime contract.

Never treat localhost reachability as sufficient authorization for operator or
automation APIs.
