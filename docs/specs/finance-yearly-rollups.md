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

