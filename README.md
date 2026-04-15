# zmail

zmail is a local-first Gmail live-sync analyzer. It connects Gmail accounts through Google OAuth, mirrors `[Gmail]/All Mail` into a local SQLite corpus, stores raw RFC822 on disk, and runs live moderation, classification, review, and overseer synthesis over that mirrored corpus.

## Current Scope

- Gmail OAuth connect flow with IMAP live sync
- corpus-only mirror of `[Gmail]/All Mail`
- live direct inference through `pi-ai`
- subscription-first, API fallback
- same-process TanStack Start + Node + Kysely + SQLite
- no active batch mode
- no send, compose, move, delete, or label-write behavior

## Prerequisites

- Node 24+
- pnpm
- mise
- one live inference backend:
  - ChatGPT or Codex subscription connected through `pnpm pi:connect`
  - `OPENAI_API_KEY`
- access to the org age key used for repo-managed SOPS secrets

## Quickstart

```bash
pnpm install
mise trust mise.toml
mise run db:migrate
mise run dev
```

Open `http://localhost:3000/accounts/new` to connect the first Gmail account.

A fresh local database starts empty. The OAuth callback completes at `/oauth/google/callback`, reuses the same account row when the same Gmail address reconnects, queues the initial bootstrap sync, ingests the newest mailbox window first, and lets the worker start the watcher after that bootstrap window succeeds. Older history then continues in the background through resumable backfill jobs.

`/accounts/$accountId` is the main sync-control page. It exposes explicit
reconnect and disconnect behavior:

- `Disconnect Gmail` removes local OAuth credentials and disables remote sync
  while preserving the local corpus.
- `Reconnect Gmail` is account-specific, starts from
  `/accounts/$accountId/reconnect`, and refuses to silently rebind a different
  Gmail identity.
- `Delete local account` lives at `/accounts/$accountId/delete`, requires typed
  email confirmation, removes mailbox-local account state, and leaves global
  registry/taxonomy/import data intact.

The same detail page also exposes `Full sync`, `Delta sync`, `Reconcile`,
`Classify backlog`, `Classify finance backlog`, `Pause`, and `Resume` when the
current connection state allows them. `Full sync` is an idempotent bootstrap or
resume control, not a destructive reset. `/messages/$messageId` exposes
`Classify now`, and `/profiles/$accountId` exposes manual overseer rebuilds.

For a clean local reset, run:

```bash
mise run db:reset && mise run db:migrate
```

`pnpm db:reset` removes the local SQLite files, account storage, and temporary OAuth state. It is the full destructive reset.

`pnpm db:reset:messages` rebuilds the message corpus while preserving account rows and `data/accounts/<accountId>/google-oauth.json`. It wipes message/state data, deletes stored raw `.eml` files, recreates the DB on the current schema, and queues fresh `sync_account_full` jobs for enabled accounts.

`pnpm db:reset:jobs` clears only the `jobs` table.

`pnpm db:migrate` now also repairs mixed local DBs that already have the V2 message model but are missing the additive secondary/registry/finance tables.

If the app reports that the local DB predates the rewritten baseline, use the lower-disruption recovery first:

```bash
pnpm db:reset:messages
```

Use the full wipe only when you also want to drop account storage:

```bash
pnpm db:reset
pnpm db:migrate
```

`pnpm reextract:parse-errors` is a supported recovery path only for fresh V2 DBs when a parser regression leaves messages in `parse_status = 'error'`. It is not a rescue path for old pre-secondary local DBs.

`pnpm reextract:bad-bodies` repairs already-parsed rows whose stored primary
body or snippet collapsed into placeholder values like `undefined`, `null`,
`Plain text version not available`, or literal HTML. It preserves row identity
and queues normal root reclassification for affected accounts.

Operator-owned classification and registry config lives on disk under:

- `data/operator/classification/root-taxonomy.yaml`
- `data/operator/classification/finance-taxonomy.yaml`
- `data/operator/classification/rules.yaml`
- `data/operator/registry/identities.yaml`
- `data/operator/registry/institutions.yaml`
- `data/operator/registry/financial-accounts.yaml`
- `data/operator/registry/sender-rules.yaml`

Those YAML files are the operator source of truth. SQLite stores imported
runtime caches. Missing files are auto-written with defaults or empty
schema-valid documents on first runtime boot or config load, and existing files
are never overwritten automatically.

## Secrets

Google OAuth bootstrap credentials are committed in repo-tracked encrypted
secrets and loaded through `mise`.

- secret files:
  - `.sops.yaml`
  - `secrets.enc.yaml`
  - `mise.toml`
- canonical local startup for Gmail-authenticated flows:
  - `mise run dev`
- one-time local trust step before `mise` will load repo config:
  - `mise trust mise.toml`
- manual env export still works if needed, but it is no longer the default

The encrypted repo secret surface only includes:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

Inference credentials remain user-local and are not stored in repo encrypted
secrets.

## Inference Backends

zmail uses `pi-ai` for all active inference work.

- `ZMAIL_PI_BACKEND=auto`
  - try `openai-subscription` first
  - fall back to `openai-api`
- `ZMAIL_PI_BACKEND=openai-subscription`
  - require `data/openai-subscription.json`
- `ZMAIL_PI_BACKEND=openai-api`
  - require `OPENAI_API_KEY`

Connect a local subscription with:

```bash
pnpm pi:connect
```

You still need one live inference backend even though Google OAuth credentials
are now repo-managed:

- `pnpm pi:connect`
- or `OPENAI_API_KEY`

## Commands

```bash
mise run dev
mise run db:migrate
mise run db:reset
mise run check
mise run check:full
pnpm dev
pnpm build
pnpm preview
pnpm router:generate
pnpm worker:drain
pnpm pi:connect
pnpm db:migrate
pnpm db:reset
pnpm db:reset:messages
pnpm db:reset:jobs
pnpm reextract:parse-errors
pnpm reextract:bad-bodies
pnpm test:unit
pnpm coverage
pnpm check
pnpm test:e2e:live
pnpm check:full
```

## Data Layout

```txt
data/
  zmail.sqlite
  openai-subscription.json
  accounts/
    <accountId>/
      google-oauth.json
      raw/
        <remoteMessageId>.eml
  tmp/
    oauth/google/
      <state>.json
```

You can override the runtime data root with `ZMAIL_DATA_DIR`.

## Runtime Logging

zmail emits structured JSON logs to stdout through `pino`.

- `ZMAIL_LOG_LEVEL` controls the minimum level and defaults to `info`
- `ZMAIL_SERVICE_VERSION` overrides the base `version` field and defaults to `dev`
- `ZMAIL_COMMIT_SHA` overrides the base `commit_hash` field and defaults to `uncommitted`
- logs are metadata-only and should include ids, counts, outcomes, and durations, never email content or secrets

## Testing

Deterministic Vitest coverage is the default proof layer:

```bash
pnpm coverage
```

Live Playwright is opt-in. It seeds a connected-account runtime state and uses real inference, but it does not automate Google login:

```bash
pnpm test:e2e:live
```

Before real Gmail runtime verification, run the full local proof gate:

```bash
mise run check:full
```

For a real Gmail OAuth and IMAP smoke pass, use [docs/testing/gmail-live-sync-manual-smoke.md](docs/testing/gmail-live-sync-manual-smoke.md).

The normal 1.0 operator flow is:

1. connect Gmail
2. wait for first full sync
3. use the account detail page for sync and backlog controls
4. use `Classify now` from message detail when needed
5. review low-confidence results
6. open overseer from the account detail page
7. queue an overseer rebuild when needed

The worker may also auto-queue `rebuild_overseer` after backlog classification
when enough newly labeled messages have accumulated since the latest profile.

During active live sync, account detail also shows the two-sided cursor state:

- `latest uid cursor`
- `earliest uid cursor`
- `backfill next uid`
- `backfill snapshot uid`

This allows new-mail delta sync and older historical backfill to continue
independently across restarts.

For Gmail-authenticated local runs, prefer starting the app with `mise run dev`
so the repo-managed encrypted Google OAuth secrets are loaded automatically.

## Docs

- Active spec: [docs/specs/gmail-imap-live-sync.md](docs/specs/gmail-imap-live-sync.md)
- Runtime flow: [docs/architecture/gmail-live-sync-flow.md](docs/architecture/gmail-live-sync-flow.md)
- Manual Gmail smoke: [docs/testing/gmail-live-sync-manual-smoke.md](docs/testing/gmail-live-sync-manual-smoke.md)
- Roadmap: [docs/roadmap/multi-lens-analysis.md](docs/roadmap/multi-lens-analysis.md), [docs/roadmap/semantic-search-and-attachments.md](docs/roadmap/semantic-search-and-attachments.md), [docs/roadmap/bulk-backfill.md](docs/roadmap/bulk-backfill.md)

Deferred work such as embeddings, attachment extraction, clustering, and semantic search is intentionally outside the active runtime contract.
