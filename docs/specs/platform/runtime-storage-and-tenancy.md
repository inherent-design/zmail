# Runtime Storage and Tenancy

## Purpose

This document defines how zmail stores org-scoped runtime state on disk and in
SQLite.

## Tenancy Model

Tenancy is per-org runtime roots, not shared-row multitenancy in one corpus
database.

Each WorkOS organization owns one runtime root:

`data/orgs/<orgId>/`

Everything inside that root is private to that organization.

## Runtime Layout

Canonical layout:

```txt
data/
  openai-subscription.json
  tmp/
    oauth/google/
      <state>.json
  orgs/
    <orgId>/
      zmail.sqlite
      zmail.sqlite-shm
      zmail.sqlite-wal
      accounts/
        <accountId>/
          google-oauth.json
          raw/
            <remoteMessageId>.eml
      operator/
        classification/
          root-taxonomy.yaml
          finance-taxonomy.yaml
          rules.yaml
        registry/
          identities.yaml
          institutions.yaml
          financial-accounts.yaml
          sender-rules.yaml
```

## Org-Scoped vs Machine-Global Files

### Org-scoped

- SQLite database files
- Gmail account OAuth token files
- raw RFC822 files
- operator classification YAML
- operator registry YAML

### Machine-global

- `data/tmp/**`
- local inference credentials such as `data/openai-subscription.json`
- non-org-scoped bootstrap tooling state

## Resolution Rules

Before any org-scoped DB or filesystem access:

1. resolve `org_id`
2. derive the org runtime root from `org_id`
3. open the org-local SQLite database and filesystem paths

No handler, script, or worker may infer org context from account ids alone.

## SQLite Boundary

Each org root contains exactly one SQLite corpus database.

Consequences:

- jobs are isolated per org DB
- Gmail accounts are isolated per org DB
- finance imports and rollups are isolated per org DB
- resetting or repairing one org runtime cannot mutate another org runtime

## Legacy Single-Tenant Claim Flow

Legacy data may exist at the old single-tenant paths:

- `data/zmail.sqlite*`
- `data/accounts/**`
- `data/operator/**`

Adoption rules:

- only an `org_admin` may claim legacy runtime data
- claim occurs through `/org/claim-legacy`
- claim is one-time and moves legacy data into `data/orgs/<orgId>/...`
- once claimed, the legacy root paths are removed or left empty
- only one org may claim a given legacy runtime

Claim flow:

1. authenticate through WorkOS
2. select or create org
3. detect legacy root data with no existing org runtime root
4. show claim screen
5. move DB, account storage, and operator config into the org root
6. migrate the moved DB if needed
7. start org-local worker supervision

## Isolation Guarantees

- no cross-org file access
- no cross-org DB access
- no shared jobs table
- no shared account storage
- no shared raw RFC822 storage

## `.gitignore` Expectations

The following must be ignored:

- `data/orgs/**`
- org-local SQLite files
- org-local OAuth token files
- org-local raw `.eml`
- org-local operator YAML unless explicitly exported for sharing

Repo-tracked placeholders may exist only as empty `.gitkeep` or equivalent
scaffolding, never as real org data.

## Out Of Scope

- shared-database row-level tenancy
- storing WorkOS user/session state in org runtime roots
- syncing org-local runtime state to remote cloud storage
