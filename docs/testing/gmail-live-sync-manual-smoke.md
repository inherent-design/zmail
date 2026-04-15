# Manual Gmail Live Sync Smoke

Use this checklist for real Google OAuth and IMAP validation. The automated Playwright suite does not perform a real Google login.

## Prerequisites

- `mise`
- access to the org age key used for repo-managed SOPS secrets
- one live inference backend:
  - `pnpm pi:connect`
  - or `OPENAI_API_KEY`

Google OAuth bootstrap credentials are already stored in repo-managed encrypted
secrets. Start credentialed local runs through `mise` so they load
automatically.

## Clean Start

```bash
pnpm install
mise trust mise.toml
mise run db:reset
mise run db:migrate
pnpm pi:connect
mise run dev
```

## Preflight Proof

Before real Gmail verification, confirm the local proof surface is green:

```bash
mise run check:full
```

## Connect Gmail

1. Open `http://localhost:3000/accounts/new`
2. Enter an account label
3. Click `Connect Gmail`
4. Complete Google consent
5. Confirm the callback lands on `/accounts/$accountId`

Expected runtime logs in the dev terminal:

- `server.action.start` and `server.action.complete` with `operation: "beginGoogleConnectCommand"`
- `server.action.start` and `server.action.complete` with `operation: "completeGoogleConnectCommand"`
- `job.queued` for the initial `sync_account_full`

## Reconnect Gmail

1. Open `/accounts/$accountId/reconnect`
2. Confirm the label is editable and the expected Gmail email is read-only
3. Click `Reconnect Gmail`
4. Complete Google consent with the same Gmail identity
5. Confirm the callback returns to the same `/accounts/$accountId`

## First Sync Checks

On `/accounts/$accountId` confirm:

- the account row exists with the connected Gmail address
- the page exposes the expected sync controls
- a `sync_account_full` job appears on `/runs`
- after bootstrap completion, message count increases
- watcher state becomes active or settles into a sane sync state
- if the mailbox is larger than one sync window, a `sync_account_backfill` job appears on `/runs`

Expected runtime logs in the dev terminal:

- `worker.job_start` and `worker.job_complete` for `sync_account_full`
- `sync.bootstrap.start` and `sync.bootstrap.complete`
- `watcher.start` followed by `watcher.connected`
- when historical work remains, `sync.backfill.start` and `sync.backfill.complete`

## Message and Classification Checks

1. Open `/messages`
2. Confirm synced messages appear
3. Open one message detail page
4. Click `Classify now`
5. Confirm `Current label` and `Moderation` are populated

## Backlog and Overseer Checks

1. Open `/accounts/$accountId`
2. Click `Classify backlog`
3. Confirm a `classify_account_backlog` job appears on `/runs`
4. Click `Open overseer`
5. Click `Queue overseer rebuild`
6. Confirm a `rebuild_overseer` job appears on `/runs`

Manual queueing is still the normal smoke assertion. The worker may also
auto-queue `rebuild_overseer` after backlog classification when the labeled
message delta since the latest profile reaches `OVERSEER_REBUILD_EVERY`.
Treat that as additional background behavior, not a required smoke step.

Expected runtime logs in the dev terminal:

- `worker.job_start` and `worker.job_complete` for `classify_account_backlog`
- `worker.classify_backlog.start`, throttled `worker.classify_backlog.progress`, and `worker.classify_backlog.complete`
- `server.action.complete` with `operation: "enqueueOverseerCommand"`
- `job.queued` and `worker.job_start` for `rebuild_overseer`

## Reconnect Check

1. From `/accounts/$accountId`, click `Disconnect Gmail`
2. Confirm the account detail page shows the disconnected state while local counts remain intact
3. Visit `/accounts/$accountId/reconnect`
4. Reconnect the same Gmail account
5. Confirm the existing account row is reused rather than duplicated

## Delete Local Account

1. Open `/accounts/$accountId/delete`
2. Confirm the page lists what will and will not be deleted
3. Type the exact Gmail email address
4. Click `Delete local account`
5. Confirm the UI returns to `/accounts` and the deleted row is gone

## Finance Filter Smoke

1. Open `/finance`
2. Confirm the year selector and the account / institution / identity / source
   filters are visible
3. If seeded or real finance data exists, click each of:
   - one account filter
   - one institution filter
   - one identity filter
   - one source filter
4. Confirm summary cards, rollups, ledger preview, and imported documents all
   change consistently for the selected filter
5. Use `Clear filters` and confirm the unfiltered year view returns

## Reconcile Check

1. Trigger `Reconcile` from `/accounts/$accountId`
2. Confirm a `sync_account_reconcile` job appears on `/runs`
3. Confirm tombstone counts remain coherent if remote removals are detected

Expected runtime logs in the dev terminal:

- `watcher.exists_enqueued`, `watcher.poll_enqueued`, or `watcher.reconcile_enqueued` as work is scheduled
- `sync.reconcile.start` and `sync.reconcile.complete`

## Restart Mid-Backfill Check

Use this when the mailbox is large enough to leave `backfill next uid` populated.

1. Wait for `/accounts/$accountId` to show a non-null `backfill next uid`
2. Stop the dev server while `sync_account_backfill` work is still ongoing or expected
3. Start the app again with `mise run dev`
4. Refresh `/accounts/$accountId`
5. Confirm:
   - the watcher reconnects
   - `backfill next uid` remains below the previous bootstrap window
   - `sync_account_backfill` resumes without duplicating rows in the corpus
   - new mail can still arrive through delta sync while historical backfill continues
