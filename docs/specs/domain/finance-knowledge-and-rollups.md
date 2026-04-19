# Finance Knowledge and Rollups

## Purpose

This document defines finance knowledge materialization and yearly rollups for
zmail vNext.

## Inputs

Finance knowledge is built from:

- current `finance_intel` heads in the org DB
- imported finance transactions
- imported finance documents
- current operator registry and taxonomy state

## Materialized Tables

- `finance_ledger_entries`
- `finance_ledger_entry_sources`
- `finance_patterns`
- `finance_export_runs`
- `finance_export_items`
- `finance_account_mappings`
- `finance_yearly_rollups`
- `finance_yearly_subcategory_rollups`

Legacy candidate tables may exist during migration, but the target model is
ledger staging plus export provenance.

## Email-Derived Finance Knowledge

The finance knowledge builder reads current `finance-intel.v3` heads with
status:

- `ready`
- `review`

It stages ledger entries by canonical key and emits:

- one `finance_ledger_entries` row per deduped ledger candidate
- one or more `finance_ledger_entry_sources` rows back to message, secondary
  result, import run, import transaction, or import document provenance
- `finance_patterns` for recurring and cross-time structure

## Imported Finance Contribution

Imported artifacts contribute to:

- staged ledger entries
- imported statement coverage
- rollup summaries
- registry suggestion reconciliation

Imported artifacts are higher authority than email-only candidates when they
carry statement/CSV/OFX row identity or stronger row provenance.

## Ledger Entry Contract

### Statuses

Active status contract:

- `ready`
- `review`
- `blocked`
- `duplicate`

Rules:

- `ready` requires amount, currency, date, direction, book scope,
  account mapping, counterparty, and dedupe key above confidence thresholds
- `review` is used when useful finance evidence exists but export confidence is
  below threshold
- `blocked` is used for parse errors, missing mappings, impossible balancing, or
  mixed personal/business rows without allocation percent
- `duplicate` is suppressed by a stronger source and retained through source
  provenance or unresolved sidecars

## Evidence Chains

`finance_ledger_entry_sources` links staged entries to:

- message id
- finance secondary result id
- import run id
- import transaction or document id
- transaction or document index
- evidence payload

Evidence must remain sufficient to explain why a candidate or rollup entry
exists.

## Dedupe Precedence

Canonical keys are chosen in this order:

1. explicit external transaction id from imported statement/CSV/OFX row
2. import run plus source document ref plus row id/index
3. normalized composite:
   - account mapping key or financial account ref
   - amount
   - currency
   - direction
   - occurred or posted date
   - normalized counterparty
4. email evidence fallback:
   - message id
   - transaction index

When keys collide, imported rows win over email-only candidates. Email-only
rows become supporting evidence where compatible.

## Patternization

`finance_patterns` records cross-time structures derived from staged entries and
document coverage:

- recurring merchant or counterparty cadence, stored as
  `pattern_kind = "recurring_merchant"` for subscription-lens consumers
- subscription cadence and amount bands
- payroll cadence
- tax document cadence by tax year and issuer
- statement coverage gaps by account/date range
- duplicate or near-duplicate imports

For `recurring_merchant` rows, `summary_json` should include:

- `counterparty`
- `book`
- `transactionCount`
- `canonicalKeys`
- optional `cadence`
- optional `amountBand`
- optional `nextExpectedAt`
- optional `lastAmountMinor`

## Rollup Model

Rollups combine:

- ready or reviewable staged ledger entries
- imported finance transactions from artifact imports when not deduped into
  staged entries yet

Primary rollups group by:

- year
- source kind
- primary category
- book scope

Subcategory rollups add:

- secondary category

Summary fields:

- inflow
- outflow
- net
- transaction count
- imported statement count
- extracted transaction count
- uncategorized count

## Finance Page Filter Semantics

Supported filters:

- `year`
- `accountId`
- `institutionId`
- `ownerIdentityId`
- `sourceKind`

Rules:

- unfiltered year view uses materialized yearly rollups as the fast baseline
- when any granular filter beyond `year` is active, summary and rollups are
  derived from the filtered combined ledger in memory
- ledger preview and imported documents are always filtered from underlying rows
- registry suggestions are filtered only by `sourceKind` in the first contract

## Identifier Semantics

Current finance filter identifiers may be:

- canonical registry ids when known
- string refs or hints from finance-intel or imported artifacts when canonical
  mapping is not yet available

They are sufficient for filtering but are not guaranteed to be globally stable
outside one org runtime.

## Rebuild Triggers

Rebuild when:

- current finance heads change
- imported finance artifacts change
- registry reconciliation materially changes matched refs
- finance taxonomy changes

## Failure Modes

- duplicate artifact import must not double-count rollups
- invalid finance-intel payloads are skipped, not materialized blindly
- full rebuild is allowed to wipe and replace derived staged rows before export

## Out Of Scope

- manual candidate adjudication
- automatic writeback into Beancount source files edited by Fava
- new non-finance semantic lenses
