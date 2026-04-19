# Gmail Sync and Ingestion

## Purpose

This document defines the Gmail provider contract for zmail vNext.

## Scope

Covered here:

- Gmail provider scope
- Google OAuth lifecycle
- IMAP sync phases
- account connection states
- raw RFC822 persistence
- reconnect, disconnect, and delete semantics

This document covers the Gmail provider/account-linking auth plane, not WorkOS
browser session login.

## Provider Scope

zmail supports one mailbox provider in the active contract:

- Gmail

Provider model:

- Google OAuth with PKCE for Gmail account authorization
- IMAP via `imapflow`
- `[Gmail]/All Mail` as the only mirrored mailbox
- corpus-only mirror, never mailbox mutation

## Account Boundary

Every Gmail account belongs to exactly one WorkOS organization because its token
files, raw RFC822 storage, and corpus rows live inside one org runtime root.

## Connection States

Active connection states:

- `connected`
- `config_error`
- `paused`
- `needs_reconnect`
- `disconnected`

Interpretation:

- `connected`: Gmail OAuth token exists and remote sync is enabled
- `config_error`: local Google OAuth bootstrap config is invalid and Google
  rejected client credentials for the current redirect URL
- `paused`: token exists but remote sync is intentionally disabled
- `needs_reconnect`: provider auth is unusable and the account requires
  reauthorization before remote sync resumes
- `disconnected`: no usable stored Gmail OAuth token remains, while local corpus
  state is preserved

## Google OAuth Flow

Google OAuth callback derivation:

- if `GOOGLE_OAUTH_REDIRECT_URL` is set, use it exactly
- otherwise derive callback from `public_origin + base_path + /oauth/google/callback`

Canonical local callback:

- `http://127.0.0.1:56711/oauth/google/callback`

### Connect

1. any authenticated org member visits `/accounts/new`
2. browser submits `POST /rpc/accounts/connect/google`
3. server creates a PKCE state file in `data/tmp/oauth/google/<state>.json`
4. state payload includes:
   - `label`
   - `flow = "connect"`
   - `ownerPrincipalEmail`
   - PKCE verifier
   - optional `accountId` for reconnect reuse
5. browser redirects to Google OAuth
6. the app-relative `/oauth/google/callback` route validates state, exchanges
   code, fetches Gmail identity, and writes the token into:
   - `data/orgs/<orgId>/accounts/<accountId>/google-oauth.json`
7. server upserts account sync state and queues `sync_account_full`

This callback is intentionally distinct from WorkOS browser login:

- Gmail account linking uses `/oauth/google/callback`
- WorkOS browser session auth uses `/auth/callback`

### Reconnect

Reconnect is account-specific.

Rules:

- route: `GET /accounts/:accountId/reconnect`
- form submit: `POST /rpc/accounts/:accountId/reconnect`
- access: account owner or `org_admin`
- OAuth state includes:
  - `accountId`
  - edited label
  - `flow = "reconnect"`
  - optional `ownerPrincipalEmail` only when the same state schema is reused

Callback rules:

- the Gmail identity chosen during reconnect must match the existing account’s
  email address case-insensitively
- mismatch fails closed
- reconnect updates the same account row in place

### Disconnect

Disconnect behavior:

- access: account owner or `org_admin`
- deletes the Gmail OAuth token file
- disables remote sync
- preserves all local corpus state
- does not delete reviews, labels, finance results, or raw materialized data

### Delete local account

Delete behavior:

- access: account owner or `org_admin`
- requires typed email confirmation
- blocks if account-scoped jobs are running
- deletes account-scoped local storage and mailbox-local DB state
- queues finance knowledge and rollup rebuilds because those materializations
  are org-shared within the org DB

## IMAP Sync Phases

### Bootstrap / full sync

- reads mailbox status
- detects missing or invalid sync state
- fetches the newest bounded UID window
- seeds cursors:
  - `latest_uid_cursor`
  - `earliest_uid_cursor`
  - `backfill_snapshot_uid`
  - `backfill_next_uid`
- queues historical backfill if older history remains

### Delta sync

- fetches bounded ascending UID windows above the current head cursor
- preserves historical backfill state
- requeues itself while newer mail remains

### Historical backfill

- fetches descending bounded UID windows toward UID `1`
- advances `earliest_uid_cursor` and `backfill_next_uid`
- completes when `backfill_next_uid` becomes `NULL`

### Reconcile

- compares known active remote message ids inside the mirrored window
- tombstones missing remote messages in that window
- never mutates mail outside the covered window

### Watchers

- Gmail watchers are org-local and account-local
- watcher lifecycle is owned by the org worker loop
- watcher failures may mark `needs_reconnect` when provider auth is invalid

## Raw RFC822 Persistence

Every mirrored Gmail message source may store:

- `raw_rfc822_path`
- `raw_sha256`

Raw mail files live under:

- `data/orgs/<orgId>/accounts/<accountId>/raw/*.eml`

Rules:

- raw RFC822 is stored only in org-local runtime roots
- raw hashes drive re-parse decisions
- re-extraction and repair tools operate from saved raw MIME

## Ingestion Outputs

Ingestion persists:

- `messages`
- `message_sources`
- `attachments`
- conversations
- parse status and body extraction fields
- content hash used by downstream freshness checks

## Worker Interplay

Successful ingest may queue:

- `classify_account_backlog`
- `classify_finance_backlog`
- `rebuild_overseer`

Successful reconnect or bootstrap may start or resume the watcher for that
account when remote sync remains enabled.

## Failure Modes

- Google OAuth mismatch during reconnect: fail closed, preserve existing account
- IMAP `UIDVALIDITY` drift: mark resync required and queue full sync
- token refresh failure: mark `needs_reconnect`
- parse failure: persist source metadata and raw MIME, degrade gracefully, and
  let repair tools operate later

## Out Of Scope

- non-Gmail providers
- sending or mutating Gmail state
- multi-provider canonical deduplication
