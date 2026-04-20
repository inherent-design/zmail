# Operator Registry and Taxonomy

## Purpose

This document defines the org-scoped operator-owned registry and taxonomy
surface for zmail vNext.

## Source Of Truth

Operator-authored files live inside the org runtime root:

```txt
data/orgs/<orgId>/operator/
  classification/
    root-taxonomy.yaml
    finance-taxonomy.yaml
    rules.yaml
  registry/
    identities.yaml
    institutions.yaml
    financial-accounts.yaml
    finance-account-mappings.yaml
    sender-rules.yaml
```

These YAML files are the source of truth.

SQLite tables are imported runtime caches.

## Classification Files

### `root-taxonomy.yaml`

Owns:

- allowed root primary buckets
- allowed root secondary buckets

### `finance-taxonomy.yaml`

Owns:

- allowed finance primary categories
- allowed finance secondary categories per primary

### `rules.yaml`

Owns:

- deterministic overlay rules
- priority
- enable/disable state
- projection targets

## Registry Files

### `identities.yaml`

Owns:

- known people or business identities
- aliases
- email addresses
- domains
- tax-owner hints

### `institutions.yaml`

Owns:

- institutions
- aliases
- domains

### `financial-accounts.yaml`

Owns:

- masked or partial account references
- owner identity linkage
- institution linkage
- display name and account hints

### `finance-account-mappings.yaml`

Owns:

- mapping keys used by finance classifier prompt context and ledger staging
- match conditions for sender/text/book/owner/institution/account evidence
- Beancount debit and credit accounts
- currency
- confidence and operator notes

The browser mapping editor writes validated YAML entries to this file, then
queues registry import and finance knowledge/rollup rebuild jobs. LLM output may
suggest mappings but must not write this file directly.

### `sender-rules.yaml`

Owns:

- sender patterns
- sender domains
- linked owner/institution/account refs
- message kind hints
- priority

## Safety Rules

Allowed facts:

- display names
- aliases
- domains
- masked account identifiers
- account last4
- tax-owner hints
- notes

Forbidden facts:

- full account numbers
- bank credentials
- OAuth tokens
- API keys

## Import Behavior

Registry/taxonomy imports are transactional.

Side effects:

- replace operator-authored cache rows
- compute or update hash state
- upsert import state
- mark dependent heads or assignment heads stale where required

Missing YAML files may be auto-written with defaults or empty schema-valid
documents on first load. Existing files are never overwritten automatically.

## Suggestion Model

Imported finance artifacts may emit suggestions.

Suggestions are stored separately in `registry_suggestions` and do not write
directly into canonical operator rows.

Email-derived finance secondary output may also emit suggestions from unresolved
entity hints:

- `source_kind = "email_finance_intel"`
- `source_ref_id = message_secondary_results.id`
- canonical keys use `email-hint:<kind>:<normalized-hint>`
- confidence is capped below auto-apply threshold at `0.8`
- inserting any hint queues `reconcile_registry_suggestions`

Suggestion statuses:

- `pending`
- `applied`
- `rejected`
- `superseded`

## Ownership Boundary

Operator-authored rows remain distinct from auto-applied suggestion rows.

Rules:

- operator imports do not delete suggestion-authored rows
- reconciliation may create suggestion-origin canonical rows where allowed
- operator-authored YAML remains the highest-trust editable surface
- finance account mappings are prompt-eligible only when matched by sender,
  text, book, owner, institution, financial account, or account last4 evidence
- mapping match fields are conjunctive when present
- finance models may emit only matched mapping keys and must not invent
  Beancount accounts

## Failure Modes

- invalid YAML: fail closed and keep existing imported runtime state
- conflicting suggestions: remain pending or become superseded, never silently
  overwrite operator-authored facts

## Out Of Scope

- direct PDF extractor writes into canonical registry tables
- storage of financial secrets or credentials in operator files
