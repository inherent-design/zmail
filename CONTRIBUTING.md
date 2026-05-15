# Contributing to zmail

## Start Here

The canonical architecture and contract surface is:

- [`docs/specs/README.md`](./docs/specs/README.md)

Do not treat the current source tree as the architecture source of truth during
the refactor. The goal is to move source toward the vNext spec set.

## Working Rules

1. update the owning spec in the same change whenever a public contract changes
2. do not preserve stale TanStack or single-tenant assumptions in active docs
3. when source is wider than spec and still belongs in vNext, update the spec
4. when the spec is wider than source and still desired, implementation is
   behind and should move toward the spec
5. prefer deleting stale docs over keeping contradictory notes around

## Canonical Spec Areas

- platform:
  - Hono
  - SvelteKit UI + WebSocket realtime
  - WorkOS auth and organizations
  - runtime storage and tenancy
  - jobs/workers/observability
- domain:
  - Gmail sync and ingestion
  - message model
  - moderation and root classification
  - secondary classifiers and projections
  - operator registry and taxonomy
  - finance imports
  - finance knowledge and rollups
- operations:
  - migrations and script policy
  - testing and proof
  - security and secrets

## Source Layout

The legacy TanStack route/component tree has been removed. Treat this as the
live runtime ownership split:

```txt
db/                  SQL migrations
docs/specs/          canonical vNext specs
lib/                 domain logic and runtime services
prompts/             moderation and classification prompts
src/                 SvelteKit browser routes, components, and client stores
scripts/             operator, admin, and test harness tooling
server/              Hono API/auth/WebSocket routes and production dispatcher
test/                unit, integration, and Playwright harness
```

## Local Development

Current local commands remain available while the rewrite is underway:

```bash
pnpm install
mise trust mise.toml
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
mise run obs:up
mise run obs:down
mise run db:migrate
mise run audit:corpus
```

Use `mise` as the canonical test interface. `mise run test` runs the quick
local gate: lint, typecheck, unit, and integration. `mise run test:coverage`
runs the full gate: lint, typecheck, covered unit buckets, integration, browser
e2e, fuzz, and stress. Benchmarks are explicit and are not part of the coverage
gate.

Use `mise run ...` for server-side commands that need repo-managed bootstrap
secrets. `mise` loads `secrets.enc.yaml` natively for those tasks. `pnpm raw:*`
scripts are implementation details used by mise tasks. Non-secret runtime
defaults live in `zmail.toml`, and `.env.example` documents local override
names.

For local server startup, `mise run dev` is the supported entrypoint when you
rely on repo-managed WorkOS or Google bootstrap secrets. Plain `pnpm raw:dev`
is the raw runtime entrypoint and does not load `secrets.enc.yaml`.

For local observability, start the stack and run the app with metrics and the
JSON log file sink enabled:

```bash
mise run obs:up
mise run dev:obs
```

`mise run obs:up` starts the local Grafana, Loki, Prometheus, and Alloy stack.

The shared local WorkOS bootstrap set is:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- optional for machine-token finance import automation:
  - `WORKOS_M2M_CLIENT_ID`
  - `WORKOS_M2M_CLIENT_SECRET`

Resolution order is:

1. environment variables
2. `zmail.toml`
3. built-in defaults

Canonical local defaults:

- `ZMAIL_PUBLIC_ORIGIN=http://127.0.0.1:56711`
- `ZMAIL_BASE_PATH=/`
- derived WorkOS callback:
  - `http://127.0.0.1:56711/auth/callback`
- derived Google OAuth callback:
  - `http://127.0.0.1:56711/oauth/google/callback`

Shared local bootstrap secrets should not carry the default local
`WORKOS_REDIRECT_URI`; keep callback derivation driven by `ZMAIL_PUBLIC_ORIGIN`
unless you intentionally set an override outside the shared secret file.

Deployment/runtime env ownership for hosted environments lives under:

- `~/production/inherent.design/platform/services`

Do not mistake current commands for the final vNext operational contract. The
target command model lives in:

- [`docs/specs/operations/migrations-cleanups-and-one-off-scripts.md`](./docs/specs/operations/migrations-cleanups-and-one-off-scripts.md)

## Testing Expectations

Follow:

- [`docs/specs/operations/testing-and-proof.md`](./docs/specs/operations/testing-and-proof.md)

Normal expectations:

- unit and integration coverage for deterministic behavior
- browser e2e only for real interactive boundaries
- manual smoke for real WorkOS/Gmail flows once the rewrite slice lands

## Security Expectations

Follow:

- [`docs/specs/operations/security-and-secrets.md`](./docs/specs/operations/security-and-secrets.md)

Never:

- commit runtime DB files
- commit org-local OAuth or raw mail files
- log tokens, auth headers, email bodies, snippets, or raw artifacts

## Documentation Hygiene

- `docs/specs/` is authoritative
- `README.md` and this file are secondary entrypoints
- `docs/testing/` is procedural, not architectural
- stale architecture notes should be removed, not left half-correct

## Commits

Use narrow, conventional-style commit messages such as:

- `feat:`
- `fix:`
- `docs:`

Keep the change summary aligned with the owning spec area.
