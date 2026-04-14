# Gmail IMAP Live Sync

## Summary

zmail runs one ingest model: Gmail OAuth with IMAP live sync. Users connect a Gmail account through Google OAuth PKCE, and the system maintains a corpus-only mirror of `[Gmail]/All Mail` through bootstrap sync, delta catch-up, periodic reconcile, historical backfill, and persistent IMAP watchers. The system never mutates the remote mailbox.

## Active Contract

- Gmail-only provider
- Google OAuth with PKCE
- IMAP via `imapflow`
- `[Gmail]/All Mail` only
- raw RFC822 stored on disk
- parsed metadata stored in SQLite
- tombstones on remote removal
- live inference through `pi-ai`
- subscription-first with optional API fallback
- no active batch execution path
- no send, compose, move, delete, or label-write behavior

## Classification Contract

The active message label contract is `message-label.v1`:

- `nsfw: boolean`
- `finance`
  - `relevant`
  - `direction`
  - `owner`
  - `accountHint`
  - `purpose`
- `social`
  - `personal`
  - `private`
  - `social`
  - `business`
- `risk`
  - `businessSensitive`
  - `leakRisk`
- `routing`
  - `primaryBucket`
  - `tags`
- `confidence`
  - `overall`
  - `finance`
  - `social`
  - `risk`
- `explanation`

The active analysis scope is `finance/social/risk/routing`. Broader lenses such as spam, opportunity, topic, relationship, and temporal analysis are roadmap work.

## Inference Backends

The active inference seam is `pi-ai`.

- preferred mode: `openai-subscription`
- fallback mode: `openai-api`
- `ZMAIL_PI_BACKEND=auto` tries subscription first, then API
- `OPENAI_API_KEY` is optional and only required when running in API mode or when subscription credentials are unavailable

Current active inference uses:

- moderation pass
- per-message classification
- overseer rebuild

Inference credentials remain user-local:

- `pnpm pi:connect`
- or `OPENAI_API_KEY`

## Runtime Logging

Active runtime logging uses `lib/log.ts` and emits single-line JSON to stdout.

- each operation gets correlation metadata including `request_id`, `trace_id`, and `span_id`
- logs are metadata-only and must not include email bodies, subjects, snippets, addresses, OAuth secrets, or API credentials
- the main event namespaces are:
  - `server.action.*`
  - `job.*`
  - `worker.*`
  - `sync.*`
  - `watcher.*`
  - `oauth.*`
  - `pi.*`
  - `cli.*`
- sync lifecycle events now use:
  - `sync.bootstrap.*`
  - `sync.delta.*`
  - `sync.backfill.*`
  - `sync.reconcile.*`
- long-running work uses bounded milestone events rather than per-item success logging

## Secret Loading

Google OAuth bootstrap credentials are repo-managed encrypted secrets.

- encrypted secret files live at the repo root:
  - `.sops.yaml`
  - `secrets.enc.yaml`
  - `mise.toml`
- the canonical local operator path is `mise run ...`
- `mise` requires a one-time trust step before loading repo config:
  - `mise trust mise.toml`
- the repo-managed encrypted secret surface is limited to:
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
- per-user inference credentials remain outside repo-encrypted secret storage

## OAuth Flow

OAuth implementation lives in `lib/google-oauth.ts`.

Scopes requested:

- `openid`
- `email`
- `profile`
- `https://mail.google.com/`

Flow:

1. `buildAuthUrl(label)` generates PKCE state and writes a temporary state file under `data/tmp/oauth/google/<state>.json`.
2. `/accounts/new` calls `beginGoogleConnectCommand` and redirects the browser to Google.
3. `/oauth/google/callback` loads and deletes the temporary state, exchanges `code + codeVerifier` for tokens, fetches the Gmail identity, normalizes the email address, and upserts the account by normalized email.
4. The callback writes `data/accounts/<accountId>/google-oauth.json`, upserts `account_sync_state`, and queues `sync_account_full`.
5. The callback does not start the watcher directly.
6. After the first successful bootstrap window, the worker starts the watcher for that account when live sync is enabled.
7. If the worker loop exits because of an unhandled fatal error, the single-start latch is cleared, the crash is logged, and a later request can restart the worker in the same process.

Reconnect identity is the normalized Gmail email address. Reconnecting the same Gmail account reuses the same account row.

## IMAP Sync Model

`lib/imap.ts` wraps `imapflow` for Gmail IMAP access.

Key operations:

- `createImapClient()` connects to `imap.gmail.com:993` with TLS and XOAUTH2
- `fetchMessageWindow()` fetches a bounded ascending IMAP UID range
- `fetchMessageWindowDescending()` fetches a bounded IMAP UID range and sorts the result descending in userland
- `writeRawEml()` stores the raw RFC822 file under `data/accounts/<accountId>/raw/<remoteMessageId>.eml` only when `remoteMessageId` is non-empty and passes path-safe validation; invalid IDs fail closed before any filesystem write
- `parseRawMessage()` parses MIME with `mailparser`, normalizes body text, derives thread keys, and extracts attachment metadata
- `getMailboxStatus()` reads mailbox cursor metadata including `UIDVALIDITY` and `UIDNEXT`

`internalDate` is used as the fallback timestamp when the parsed message date is absent.

Current message-model caveats:

- `messages.received_at` is the canonical user-facing message timestamp
- `messages.created_at` is currently the row creation timestamp, not a dedicated ingestion field
- `messages.thread_key` is a local heuristic and not the canonical Gmail conversation identity
- forwarded-email and parse-error body extraction remain best-effort in the active runtime

The planned refactor for timestamps, conversations, and body extraction is tracked in [message-model-v2.md](./message-model-v2.md).

Current data semantics:

- this is a Gmail-only corpus mirror
- each stored `messages` row currently corresponds to one Gmail `message_sources`
  row
- the active runtime does not implement cross-source canonical email
  deduplication
- `messages.message_id` is the RFC822 `Message-ID`, not the current dedupe key
- `message_sources.remote_message_id` is the current Gmail dedupe key per
  account
- `message_sources.remote_thread_id` is the Gmail-native thread identity
- `messages.content_sha256` drives moderation and classification freshness

## Cursor Model

`account_sync_state` persists a two-sided live-sync window per account:

- `uidvalidity`
  - the current mailbox epoch
- `latest_uid_cursor`
  - the highest UID covered in the current epoch
- `earliest_uid_cursor`
  - the lowest UID covered in the current epoch
- `backfill_snapshot_uid`
  - the fixed mailbox head UID captured when the current historical backfill epoch started
- `backfill_next_uid`
  - the next descending UID window endpoint to fetch for historical backfill, or `NULL` when historical backfill is complete

Timestamp fields:

- `last_bootstrap_started_at`
- `last_bootstrap_completed_at`
- `last_delta_sync_at`
- `last_reconcile_at`
- `last_backfill_sync_at`
- `backfill_completed_at`

This model allows zmail to:

- continue ingesting new mail from the head
- continue historical backfill toward older UIDs
- resume both directions after restart
- bound replayed work after crashes to at most one unfinished window

Migration limitation:

- legacy interrupted full-sync rows cannot recover an exact historical lower-bound cursor because the old schema never stored one
- the first post-migration bootstrap for those rows may replay from a fresh mailbox head snapshot once

## Sync Jobs

### Bootstrap / Resume

`runFullSync(accountId)` is the bootstrap and resume coordinator.

Rules:

1. require a sync-enabled account
2. ensure a fresh OAuth token
3. load mailbox status and current head UID as `uidNext - 1`
4. if sync state is missing, incomplete, or `UIDVALIDITY` changed:
   - reset the current epoch
   - ingest the newest bounded UID window immediately
   - set:
     - `latest_uid_cursor`
     - `earliest_uid_cursor`
     - `backfill_snapshot_uid`
     - `backfill_next_uid`
   - stamp bootstrap timestamps
5. if sync state already exists for the same epoch:
   - do not reset progress
   - run at most one bounded delta catch-up window when the mailbox head advanced
   - ensure historical backfill is queued when `backfill_next_uid` is not `NULL`
6. update account status:
   - `backfilling` when historical work remains
   - `idle` when the full historical snapshot is complete
7. update `last_synced_at`

After a successful bootstrap / resume:

- queue `classify_account_backlog` when new content was ingested
- queue `sync_account_backfill` when historical work remains
- start the watcher when the account is sync-enabled

`Full sync` in the UI means this idempotent bootstrap / resume operation. It is not a destructive hard resync.

### Delta Catch-Up

`runDeltaSync(accountId)` handles new mail above the head cursor.

Rules:

1. require existing `account_sync_state`
2. require a sync-enabled account
3. ensure a fresh token
4. compare `UIDVALIDITY`
5. if `UIDVALIDITY` changed:
   - mark `resync_required`
   - queue `sync_account_full`
   - stop delta processing for the old epoch
6. fetch at most one ascending UID window above `latest_uid_cursor`
7. ingest each message
8. update `latest_uid_cursor`, `last_delta_sync_at`, and account status
9. if the mailbox head is still ahead, queue another `sync_account_delta`

After a successful delta sync:

- queue `classify_account_backlog` when new messages were ingested
- preserve historical backfill state and keep account status `backfilling` when older work remains

### Historical Backfill

`runBackfillSync(accountId)` handles older unsynced mail below the bootstrap window.

Rules:

1. require existing `account_sync_state`
2. require a sync-enabled account
3. ensure a fresh token
4. read `backfill_next_uid`
5. if `backfill_next_uid` is `NULL`, historical backfill is already complete
6. compute:
   - `range_start = max(1, backfill_next_uid - ZMAIL_IMAP_FETCH_WINDOW + 1)`
   - `range_end = backfill_next_uid`
7. fetch that bounded UID range and sort the results descending in userland
8. ingest each message
9. update:
   - `earliest_uid_cursor = range_start`
   - `backfill_next_uid = range_start > 1 ? range_start - 1 : NULL`
   - `last_backfill_sync_at`
   - `backfill_completed_at` when historical work reaches UID `1`
10. queue another `sync_account_backfill` when more historical work remains

Historical backfill never rewinds `latest_uid_cursor`.

### Reconcile

`runReconcile(accountId)`:

1. require a sync-enabled account
2. require a tracked sync window:
   - `account_sync_state`
   - `uidvalidity`
   - `earliest_uid_cursor`
   - `latest_uid_cursor`
3. ensure a fresh token
4. read mailbox status and compare `UIDVALIDITY`
5. if `UIDVALIDITY` changed:
   - mark `resync_required`
   - queue `sync_account_full`
   - do not tombstone current rows from reconcile
6. fetch remote Gmail message IDs only for the mirrored UID window:
   - `${earliest_uid_cursor}:${latest_uid_cursor}`
7. compare them only to local active `message_sources` in that same window and epoch
8. mark missing remote messages in that window as `tombstoned`
9. update `last_reconcile_at` only after a successful in-window reconcile pass

Reconcile is triggered both manually and by the watcher timer driven by `ZMAIL_SYNC_RECONCILE_MS`.

Reconcile only covers the currently mirrored UID window. Tombstones outside that covered window are deferred until historical backfill reaches them.

Reconcile does not clear `backfilling`. If historical work remains, account status stays `backfilling`.

## Ingest Pipeline

`ingestMessage()` handles both new messages and content changes.

For existing synced messages:

- when the raw content hash is unchanged:
  - only observation and source state is updated
  - `last_seen_at`, `imap_uid`, `uidvalidity`, `state`, and tombstone state are
    refreshed
- when raw content hash changed:
  - rewrite the raw `.eml`
  - re-parse the message
  - refresh `messages`, `attachments`, and `message_sources` together
  - refresh normalized sender fields, recipients, subject, thread key, received
    timestamp, normalized body, snippet, parse status, token estimate,
    attachment count, and attachment rows
  - update `messages.content_sha256`
  - later classifier freshness is driven by `messages.content_sha256`

For new messages:

- write raw `.eml`
- parse and normalize
- insert `messages`
- insert `attachments`
- insert `message_sources`

Parse errors are non-fatal ingestion fallbacks:

- sync continuity and source provenance are preserved
- structured parsed fields and normalized body currently degrade to empty/null
  fallback values
- a structured parse failure reason is not stored in the active runtime

Duplicate stored data remains prevented by `message_sources` identity checks and unique `(account_id, remote_message_id)` enforcement. Replay after crashes is tolerated, but bounded to at most one unfinished window.

## Watchers

`lib/watchers.ts` manages one in-memory watcher per sync-enabled Gmail account.

Watcher behavior:

- connect with XOAUTH2
- open the selected mailbox and retain the mailbox lock explicitly
- rely on `imapflow` auto-idle semantics while the mailbox remains open
- enqueue `sync_account_delta` on `exists`
- enqueue `sync_account_delta` on poll fallback every `ZMAIL_IMAP_POLL_MS`
- enqueue `sync_account_reconcile` on periodic reconcile every `ZMAIL_SYNC_RECONCILE_MS`
- update idle heartbeat every `ZMAIL_IMAP_MAX_IDLE_MS`
- on reconnect or stop:
  - clear timers
  - release mailbox lock
  - logout IMAP client

On repeated failures, watchers back off exponentially up to 30 minutes.

## Pause / Resume

Pause is account-wide remote sync suppression.

When an account is paused:

- `sync_enabled = 0`
- watcher activity stops
- bootstrap, delta, reconcile, and historical backfill jobs skip remote work
- manual remote sync commands fail until the account is resumed

When an account is resumed:

- `sync_enabled = 1`
- the watcher restarts
- `sync_status` returns to:
  - `backfilling` when `backfill_next_uid` exists
  - `idle` otherwise
- pending historical work is re-queued

`Classify backlog` remains allowed while paused because it only operates on the local corpus.

## Classification Backlog

`classify_account_backlog` is active runtime behavior.

The job selects account messages where:

- no `message_labels` row exists, or
- `message_labels.content_sha256 != messages.content_sha256`

For each selected message:

1. ensure moderation exists
2. classify with the current prompt version
3. persist `classification_results.input_content_sha256`
4. persist `message_labels.content_sha256`
5. create one open review when `confidence.overall < LOW_CONFIDENCE_THRESHOLD`

Manual overrides also stamp the current content hash so stale-content detection remains correct.

After a successful backlog run:

- manual `rebuild_overseer` remains available from `/profiles/$accountId`
- the worker may auto-queue `rebuild_overseer` when newly labeled message growth since the latest profile reaches `OVERSEER_REBUILD_EVERY`

## Data Model

Active tables:

- `accounts`
- `account_sync_state`
- `messages`
- `attachments`
- `message_sources`
- `jobs`
- `moderation_results`
- `classification_results`
- `message_labels`
- `reviews`
- `overseer_profiles`

## UI Surface

Operator-facing sync controls live on `/accounts/$accountId`.

Current controls:

- `Full sync`
- `Delta sync`
- `Reconcile`
- `Classify backlog`
- `Pause`
- `Resume`
- `Disconnect`

Current sync-state display includes:

- `uidvalidity`
- `latest uid cursor`
- `earliest uid cursor`
- `backfill next uid`
- `backfill snapshot uid`
- watcher state
- sync status

Message detail at `/messages/$messageId` exposes `Classify now`.
