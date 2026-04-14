# Gmail Live Sync Flow

Concrete worker, watcher, and data-flow description for the active Gmail live-sync runtime.

## Runtime Observability

The runtime emits structured JSON logs to stdout through `lib/log.ts`.

- server actions emit `server.action.*`
- job queue and lease state emit `job.*`
- worker orchestration emits `worker.*`
- sync phases emit:
  - `sync.bootstrap.*`
  - `sync.delta.*`
  - `sync.backfill.*`
  - `sync.reconcile.*`
- watcher lifecycle emits `watcher.*`
- OAuth, inference, and CLI flows emit `oauth.*`, `pi.*`, and `cli.*`

## Worker Startup

The worker loop in `lib/worker.ts` starts with:

1. `runMigrations()`
2. `requeueExpiredJobs()`
3. `restoreWatchers()`
4. repeated `runWorkerIteration({ waitOnIdle: true })`

`bootServer()` ensures the worker is started once per process.

## Job Lease Safety

Every claimed job gets a lease expiration time.

- the generic worker wrapper renews that lease on the live heartbeat while the job is running
- crash recovery requeues expired `running` jobs at worker startup
- sync jobs are intentionally bounded to one IMAP window per run so replay after a crash is limited to the unfinished window

## OAuth Callback to First Sync

The callback route at `/oauth/google/callback` performs:

1. load and delete PKCE state
2. exchange `code + codeVerifier`
3. fetch Gmail identity
4. normalize email address
5. upsert `accounts`
6. upsert `account_sync_state`
7. write `data/accounts/<accountId>/google-oauth.json`
8. queue `sync_account_full`
9. redirect to `/accounts/$accountId`

The callback does not start the watcher directly.

## Cursor State

`account_sync_state` carries the resumable two-sided sync window:

- `uidvalidity`
- `latest_uid_cursor`
- `earliest_uid_cursor`
- `backfill_snapshot_uid`
- `backfill_next_uid`
- bootstrap, delta, reconcile, backfill, and watcher timestamps

Interpretation:

- `latest_uid_cursor` tracks the head of the mirrored UID range
- `earliest_uid_cursor` tracks the oldest mirrored UID range boundary
- `backfill_snapshot_uid` fixes the mailbox head captured for the current historical epoch
- `backfill_next_uid` points to the next descending historical window to fetch

## Bootstrap / Resume Flow

`sync_account_full` executes `runFullSync()`.

Coordinator behavior:

1. require a sync-enabled account
2. ensure a fresh Google token
3. connect IMAP and read mailbox status
4. derive the current head UID from `uidNext - 1`
5. decide whether the account needs a fresh bootstrap epoch:
   - missing sync state
   - incomplete state from a legacy or interrupted epoch
   - `UIDVALIDITY` drift
6. if a fresh epoch is needed:
   - reset cursor fields
   - ingest the newest bounded UID window immediately
   - seed `latest_uid_cursor`, `earliest_uid_cursor`, `backfill_snapshot_uid`, and `backfill_next_uid`
7. if the existing epoch is valid:
   - run at most one bounded delta window when the head advanced
   - preserve historical backfill state
8. update account status:
   - `backfilling` when historical work remains
   - `idle` when the epoch is fully covered
9. ensure `sync_account_backfill` is queued when `backfill_next_uid` is not `NULL`

After a successful bootstrap / resume:

- the worker queues `classify_account_backlog` when new content was ingested
- the worker starts the watcher when the account is Gmail and `sync_enabled=1`

## Delta Catch-Up Flow

`sync_account_delta` executes `runDeltaSync()`.

Delta behavior:

1. load the existing sync cursor state
2. require a sync-enabled account
3. ensure a fresh token
4. open the mailbox
5. compare `UIDVALIDITY`
6. if the mailbox epoch changed:
   - mark `resync_required`
   - queue `sync_account_full`
   - stop delta work for the stale epoch
7. fetch one bounded ascending UID window above `latest_uid_cursor`
8. ingest each message
9. advance `latest_uid_cursor`
10. if the mailbox head is still ahead, queue another `sync_account_delta`
11. leave account status as `backfilling` when older work remains

When delta sync ingests new content, the worker queues `classify_account_backlog`.

## Historical Backfill Flow

`sync_account_backfill` executes `runBackfillSync()`.

Backfill behavior:

1. load the existing sync cursor state
2. require a sync-enabled account
3. ensure a fresh token
4. read `backfill_next_uid`
5. if it is `NULL`, historical work is complete and the job is a no-op
6. compute the next descending bounded UID window
7. fetch that explicit range and sort it descending in userland
8. ingest each message
9. advance:
   - `earliest_uid_cursor`
   - `backfill_next_uid`
   - `last_backfill_sync_at`
10. when `backfill_next_uid` becomes `NULL`, stamp `backfill_completed_at` and set account status to `idle`
11. otherwise, queue another `sync_account_backfill`

This lets new mail continue through delta sync while historical work proceeds toward UID `1`.

## Reconcile Flow

`sync_account_reconcile` executes `runReconcile()`.

Reconcile behavior:

1. require a sync-enabled account
2. require a tracked sync window in `account_sync_state`
3. ensure a fresh token
4. read mailbox status and compare `UIDVALIDITY`
5. if `UIDVALIDITY` changed:
   - mark `resync_required`
   - queue `sync_account_full`
   - skip tombstoning for this reconcile run
6. open the mailbox
7. fetch Gmail message IDs only for `${earliest_uid_cursor}:${latest_uid_cursor}`
8. compare them only to local active `message_sources` in the same UID window and epoch
9. tombstone missing remote messages from that mirrored window
10. update `last_reconcile_at` only after a successful in-window reconcile pass

Reconcile is triggered manually and by the watcher reconcile timer.

Reconcile is intentionally window-scoped. Tombstones outside the covered window are deferred until backfill reaches them.

Reconcile must not collapse `backfilling` to `idle`.

## Ingest And Content Change Handling

`ingestMessage()` is the core sync write path.

For a new synced message:

- write raw RFC822 to disk
- parse MIME
- normalize message fields
- insert `messages`
- insert `attachments`
- insert `message_sources`

For an already-known synced message:

- update source cursor fields
- reactivate if tombstoned
- when `raw_sha256` changed:
  - rewrite the raw `.eml`
  - re-parse MIME
  - refresh sender fields, recipients, subject, thread key, received timestamp, normalized body, snippet, parse status, token estimate, attachment count, and attachment rows
  - update `messages.content_sha256`

Duplicate stored data is prevented by the existing `message_sources` identity checks and the unique `(account_id, remote_message_id)` index.

## Classification Backlog Flow

`classify_account_backlog` executes `classifyAccountBacklogJob()`.

1. select account messages that are unlabeled or stale by content hash
2. load latest overseer context
3. for each selected message:
   - ensure moderation exists
   - classify with the current prompt
   - persist `classification_results` with `input_content_sha256`
   - upsert `message_labels` with `content_sha256`
4. create one open review for low-confidence results

This job is queued:

- manually from `/accounts/$accountId`
- after successful bootstrap or delta runs that ingest new content

After a successful backlog run, the worker may also auto-queue `rebuild_overseer`
when newly labeled message growth since the latest profile reaches
`OVERSEER_REBUILD_EVERY`.

## Watcher Lifecycle

`lib/watchers.ts` keeps one watcher per sync-enabled Gmail account.

Watcher state holds:

- `ImapFlow` client
- mailbox lock
- poll timer
- reconcile timer
- heartbeat timer
- reconnect timer

### Start

1. load the account and sync state
2. ensure a fresh token
3. connect IMAP
4. open the selected mailbox and keep the mailbox lock
5. set watcher status to `idle`
6. register event handlers and timers

### Timers And Events

- `exists` event -> enqueue `sync_account_delta`
- poll interval -> enqueue `sync_account_delta`
- reconcile interval -> enqueue `sync_account_reconcile`
- idle heartbeat interval -> update sync-state heartbeat

Watchers use `imapflow` auto-idle behavior while the mailbox remains open.

### Stop Or Reconnect

On stop or reconnect:

- clear poll, reconcile, heartbeat, and reconnect timers
- release the mailbox lock
- logout the IMAP client
- update watcher status

If a connection fails, the watcher records the failure and schedules exponential backoff reconnect.

## Pause And Resume

Pause is an account-wide remote sync stop.

- pausing sets `sync_enabled=0`
- watcher activity stops
- bootstrap, delta, reconcile, and backfill work skip while paused
- queued remote sync jobs may still be claimed, but they should complete as skipped work and must not requeue follow-up sync jobs

Resume reverses that:

- set `sync_enabled=1`
- restore watcher activity
- restore `sync_status` to `backfilling` when `backfill_next_uid` exists, else `idle`
- requeue historical backfill when needed

`classify_account_backlog` remains a local-only operation and is still allowed while paused.

## Persistence Boundaries

SQLite holds:

- account rows
- sync cursor state
- parsed messages
- attachment metadata
- moderation results
- classification history
- current labels
- reviews
- overseer profiles
- job state

Disk holds:

- OAuth tokens at `data/accounts/<accountId>/google-oauth.json`
- raw Gmail messages at `data/accounts/<accountId>/raw/<remoteMessageId>.eml`
