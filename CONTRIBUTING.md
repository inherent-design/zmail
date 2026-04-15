# Contributing to zmail

## Prerequisites

- Node 24+
- pnpm
- mise
- macOS or Linux
- access to the org age key used for repo-managed SOPS secrets
- one live inference backend for credentialed flows:
  - ChatGPT or Codex subscription connected through `pnpm pi:connect`
  - `OPENAI_API_KEY`

## Getting Started

```bash
git clone <repository-url>
cd zmail
pnpm install
mise trust mise.toml
mise run db:migrate
mise run check
```

A fresh local database starts empty. Connect Gmail accounts through
`/accounts/new`. Reconnect an existing account through
`/accounts/$accountId/reconnect`, use `Disconnect Gmail` on
`/accounts/$accountId` to preserve the local corpus while removing OAuth
credentials, and use `/accounts/$accountId/delete` for typed-confirm local
account deletion. Do not expect a seeded default account.

For Gmail-authenticated local runs, prefer `mise run ...` so the repo-managed
encrypted Google OAuth secrets are loaded automatically.
`mise` requires a one-time trust step per checkout before it will load
`mise.toml`: `mise trust mise.toml`.

For a destructive local reset, run:

```bash
mise run db:reset && mise run db:migrate
```

`pnpm db:reset:messages` preserves account rows and `data/accounts/<accountId>/google-oauth.json`, drops corpus state and raw `.eml` files, recreates the DB on the current schema, and queues fresh `sync_account_full` jobs for enabled accounts.

`pnpm db:reset:jobs` clears only the `jobs` table.

`pnpm db:migrate` repairs mixed local DBs that already have the V2 message model but are missing the additive secondary/registry/finance tables.

If the runtime reports that the local DB predates the rewritten baseline, prefer `pnpm db:reset:messages`. Use `pnpm db:reset` plus `pnpm db:migrate` only when you also want to discard account storage and reconnect Gmail accounts.

`pnpm reextract:parse-errors` is a supported recovery path only for fresh V2 DBs when a parser regression leaves messages stuck in `parse_status = 'error'`. It is not a rescue path for old pre-secondary local DBs.

`pnpm reextract:bad-bodies` is the repair path for rows that parsed
successfully but stored unusable body output such as `undefined`, `null`,
`Plain text version not available`, or literal HTML in `body_text_primary` or
`snippet`. It reparses from the saved raw MIME, preserves row identity, and
queues normal root reclassification for affected accounts.

The operator source of truth lives on disk, not in SQLite:

- `data/operator/classification/root-taxonomy.yaml`
- `data/operator/classification/finance-taxonomy.yaml`
- `data/operator/classification/rules.yaml`
- `data/operator/registry/identities.yaml`
- `data/operator/registry/institutions.yaml`
- `data/operator/registry/financial-accounts.yaml`
- `data/operator/registry/sender-rules.yaml`

Runtime tables are imported caches. Missing YAML files are auto-written with
defaults or empty schema-valid documents on first runtime boot or config load.
Existing files are never overwritten automatically.

Install the Playwright browser only when you need the live browser suite:

```bash
pnpm playwright:install
```

## Current Workspace Layout

```txt
zmail/
  app/                 active TanStack route tree and server functions
  db/                  SQL migrations
  docs/                active specs, architecture notes, testing docs, roadmap
  lib/                 sync, SQLite, worker, inference, parsing, and overseer logic
  prompts/             moderation, classification, and overseer prompts
  scripts/             small CLI entrypoints
  test/                unit, integration, and Playwright harness
  data/                local runtime state
```

## Development Workflow

1. branch from the active integration branch
2. make the smallest change that closes one real behavior or contract gap
3. update docs in the same change when behavior, commands, or workflow changed
4. run the verification commands
5. submit the change with a narrow summary and explicit verification notes

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
pnpm typecheck
pnpm test:unit
pnpm coverage
pnpm lint
pnpm check
pnpm test:e2e:live
pnpm check:full
pnpm db:migrate
pnpm db:reset
pnpm db:reset:messages
pnpm db:reset:jobs
pnpm reextract:parse-errors
pnpm reextract:bad-bodies
pnpm worker:drain
pnpm pi:connect
pnpm playwright:install
```

`pnpm check` is the default pre-review gate.

## Secrets

zmail now uses the org-wide `SOPS + age + mise` pattern for repo-managed Google
OAuth bootstrap secrets.

- committed encrypted files:
  - `.sops.yaml`
  - `secrets.enc.yaml`
  - `mise.toml`
- one-time local trust command:
  - `mise trust mise.toml`
- repo-managed encrypted values:
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
- user-local values that remain out of repo secret storage:
  - `OPENAI_API_KEY`
  - `data/openai-subscription.json`
  - Gmail account token files under `data/accounts/<accountId>/google-oauth.json`

## Testing Strategy

zmail uses deterministic unit and integration coverage as the primary proof layer, then an opt-in credentialed Playwright harness over the real `server + worker + browser` flow.

Do not make live browser tests the only proof for behavior that can be tested cheaper and more deterministically.

The current proof layers are:

- unit tests for parsers, schemas, sync helpers, watcher logic, and small state transitions
- integration tests for SQLite, worker jobs, server actions, and persistence seams
- live Playwright for seeded connected-account flows with real inference
- manual Gmail smoke testing for real Google OAuth and IMAP behavior

`pnpm test:e2e:live` is opt-in. It requires a connected subscription record or `OPENAI_API_KEY`. It does not attempt a real Google login. Use [docs/testing/gmail-live-sync-manual-smoke.md](docs/testing/gmail-live-sync-manual-smoke.md) for real Gmail smoke validation.

## Dependency Policy

- use `pnpm add` and `pnpm add -D`
- keep the tree small and explicit
- prefer built-in Node facilities and narrow libraries over framework sprawl
- do not add dependencies for one-off helpers that can be handled with platform APIs

## Architecture and Contract Policy

The active runtime scope is narrow:

- Gmail OAuth connect flow with IMAP live sync
- corpus-only mirror of `[Gmail]/All Mail`
- live direct inference only
- same-process TanStack Start + Node + Kysely + SQLite
- no active batch mode

Credentialed local workflows should use `mise run ...` so the encrypted Google
OAuth bootstrap secrets are available without manual env export.

When behavior changes across one of these seams, update the relevant prompt, docs, or command reference in the same change:

- Gmail OAuth and token lifecycle
- IMAP sync and watcher behavior
- SQLite schema and job state
- server action contracts
- review and override semantics
- live inference backend selection

Dead starter code and deferred runtime paths should be removed, not left half-supported.

## Logging and Observability

Use `lib/log.ts` as the only runtime logger.

- use wide JSON events with stable `event`, `operation`, correlation ids, outcome, and duration fields
- prefer one bounded start or complete envelope per server action, job, sync phase, watcher lifecycle change, or CLI command
- for long-running operations, emit cumulative milestone events instead of noisy per-item success logs
- include safe metadata only: ids, counts, mailbox names, backend or model names, watcher status, and retry state
- never log message content, email addresses, subjects, snippets, bodies, raw RFC822, OAuth codes, access tokens, refresh tokens, auth headers, API keys, or provider payloads
- temporary debug logging should be replaced with structured events or removed before finishing the change

## Code Style

### General

- TypeScript, ESM, strict typing
- technical reference tone in docs and comments
- no em dashes in prose
- no filler, flattery, or marketing cadence
- small concrete functions over speculative abstractions

### Comments

Default to no comments. Comment only when the reason is non-obvious, when a workaround exists, or when an external constraint matters.

### Errors

- fail with clear operational messages
- do not branch on free-form error text when a structured condition is available
- preserve the useful context needed to debug the failure

## Test Expectations for New Work

Every feature starts with tests.

For parser, sync, state, and server-boundary work, expected proof usually means:

- schema or helper tests
- failure-path tests
- SQLite-backed integration coverage when persistence changes
- UI or Playwright coverage only when the behavior is specifically interactive

If a behavior cannot yet be tested, add the smallest missing harness first.

## Coverage Policy

Coverage is enforced at 100 percent for the active source tree.

That means:

- cover the active code
- delete dead starter files
- delete deferred runtime paths that are not part of the product contract

Do not game the number with shallow tests around trivial wrappers. Raise coverage by closing real behavior gaps.

## Commits

Use conventional-style prefixes:

- `feat:`
- `fix:`
- `docs:`
- `test:`
- `refactor:`
- `chore:`
- `build:`

Use imperative mood. Keep the subject under 72 characters. Explain why in the body when a body is needed.

## Agent Guidelines

These rules also apply to coding agents working in the repo.

- do not reopen settled scope without evidence
- do not add abstractions for future providers unless current runtime or tests require them
- do not leave starter or deferred code half-integrated
- do update docs when the command surface or behavior changed
- do include verification commands in handoff summaries

## License

By contributing, you agree that your contributions will be licensed under the project license in this repository.
