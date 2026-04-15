# Finance Yearly Rollups

## Summary

The finance page is year-first.

Rollups combine email-derived finance intelligence with imported finance
 artifacts into stable yearly aggregates and ledger previews.

## Storage

- `finance_yearly_rollups`
- `finance_yearly_subcategory_rollups`

## Inputs

- current `finance_intel` heads
- imported finance transactions
- imported finance documents
- registry state
- finance taxonomy state

## Output shape

Per year and source kind:

- inflow
- outflow
- net
- transaction count
- imported statement count
- extracted transaction count
- uncategorized count

Subcategory rollups add:

- `primaryCategory`
- `secondaryCategory`

## UI role

The finance page should surface:

- year selector
- account / institution / identity / source filters
- summary cards
- primary rollups
- subcategory rollups
- ledger preview
- imported document coverage
- registry suggestion state

## Filter model

- The unfiltered year view uses `finance_yearly_rollups` and
  `finance_yearly_subcategory_rollups` as the fast baseline.
- When any granular filter is active beyond `year`:
  - `accountId`
  - `institutionId`
  - `ownerIdentityId`
  - `sourceKind`
  the loader derives summary, primary rollups, and subcategory rollups from the
  filtered combined ledger in memory.
- Ledger preview and imported documents are always filtered directly from the
  underlying rows.
- Registry suggestions are currently filtered only by `sourceKind`.

## Current identifier semantics

- `institutionId` and `ownerIdentityId` filter values are currently string
  refs or hints surfaced from email-derived finance intel and imported finance
  artifacts.
- They are not guaranteed to be canonical registry ids in this implementation.
