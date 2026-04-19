# Gmail Live Sync Manual Smoke

This smoke plan targets the vNext runtime defined in `docs/specs/`.

Use it once the Hono + Hono JSX + WorkOS rewrite slice is available. It is not
a claim that the current source tree already implements every step below.

## Canonical References

- [system overview](../specs/system-overview.md)
- [auth and organizations](../specs/platform/auth-and-organizations.md)
- [runtime storage and tenancy](../specs/platform/runtime-storage-and-tenancy.md)
- [Gmail sync and ingestion](../specs/domain/gmail-sync-and-ingestion.md)
- [finance imports](../specs/domain/finance-imports.md)
- [testing and proof](../specs/operations/testing-and-proof.md)

## Prerequisites

- `mise run dev` loads `secrets.enc.yaml` natively for the server task
- local default origin is `http://127.0.0.1:56711`
- if you prefer `localhost`, set `ZMAIL_PUBLIC_ORIGIN=http://localhost:56711`
- WorkOS browser auth is configured for local development
- WorkOS allows:
  - `http://127.0.0.1:56711/auth/callback`
  - `http://localhost:56711/auth/callback` when using the localhost override
- Google OAuth bootstrap credentials are configured
- one inference backend is available
- local machine has permission to create or select a WorkOS org
- optional: WorkOS M2M credentials for finance import automation

## Smoke 1: WorkOS Login and Org Selection

1. start the app locally
2. open the app in a browser
3. verify unauthenticated access redirects to `/auth/login`
4. complete WorkOS login
5. verify org selection or org creation occurs when needed
6. verify the app shell shows the active organization

Expected result:

- protected pages require WorkOS auth
- active org context exists before any operator page loads

## Smoke 2: Legacy Runtime Claim

Run this only when legacy single-tenant data exists.

1. log in as an `org_admin`
2. select an org with no runtime root yet
3. verify `/org/claim-legacy` is shown
4. claim the legacy runtime
5. verify the org runtime root is created under `data/orgs/<orgId>/...`

Expected result:

- DB, account storage, and operator config move into the org root
- no duplicate org roots are created

## Smoke 3: Gmail Connect

1. open `/accounts/new`
2. start Google OAuth connect
3. complete the Google flow
4. return through `/oauth/google/callback`
5. verify an account row appears in the selected org
6. verify the initial sync job is queued

Expected result:

- token file exists only in the org runtime root
- bootstrap sync begins for the selected org only

## Smoke 4: Sync Lifecycle

1. wait for bootstrap sync to complete
2. verify newest mail appears first
3. verify historical backfill progresses
4. trigger a delta sync
5. trigger reconcile

Expected result:

- account status transitions make sense
- raw RFC822 files appear under the org-local account raw directory
- worker jobs and watcher behavior stay org-local

## Smoke 5: Disconnect, Reconnect, Delete

1. disconnect Gmail from the account detail page
2. verify local corpus remains
3. reconnect the same Gmail identity
4. verify reconnect fails closed if the wrong Gmail identity is chosen
5. open the delete page
6. verify typed email confirmation is required
7. delete the account

Expected result:

- disconnect preserves corpus and removes provider token
- reconnect updates the same account row
- delete removes account-scoped runtime state and requeues finance materialized
  rebuilds

## Smoke 6: Browser Authorization Matrix

1. test with `org_admin`
2. test with `org_operator`
3. test with `org_viewer`

Verify:

- viewer cannot mutate operator state for accounts they do not own
- viewer who owns an account can reconnect, disconnect, and delete that account
- operator can run normal sync/classification/import actions
- admin can perform destructive or migration actions such as legacy claim or
  account deletion for any account

## Smoke 7: Finance Import via Machine Token

1. acquire an org-scoped WorkOS M2M token
2. submit an artifact to `POST /api/finance/imports`
3. submit the exact same artifact again
4. submit the same source file with a different artifact hash

Expected result:

- first import returns `202 queued`
- exact duplicate returns `200 already_imported`
- new artifact hash for the same source file is accepted
- rollups count each unique artifact once

## Smoke 8: Org Isolation

1. create or use two organizations
2. connect Gmail in one org only
3. verify the second org sees no accounts or messages from the first
4. verify finance imports into one org do not appear in the other

Expected result:

- runtime data is isolated by org root
- no cross-org DB or file leakage occurs

## Notes

- if the smoke uncovers a source/spec mismatch, update the owning vNext spec
  first or in the same change
- do not patch the manual smoke doc to match accidental implementation drift
