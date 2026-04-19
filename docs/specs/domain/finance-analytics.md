# Finance Analytics

## Purpose

This document defines the first finance analytics surface for zmail vNext.

## Scope

The MVP is an operator-dense instrument panel focused on:

- cashflow analytics by month
- category inflow, outflow, and net pressure
- recurring merchant and subscription patterns
- ledger preview and drilldown tables

Beancount and Fava export health stays visible, but it is secondary to
cashflow, category, and subscription analysis.

## Data Sources

Finance analytics uses existing materializations:

- `finance_ledger_entries`
- `finance_ledger_entry_sources`
- `finance_patterns`
- `finance_yearly_rollups`
- `finance_yearly_subcategory_rollups`
- `finance_export_runs`
- `finance_export_items`

The first pass must not add DB tables. If analytics needs richer data, source
services should derive it from the current ledger, rollup, pattern, and export
tables.

## Page Islands

The finance page owns these islands:

| Island | Purpose |
| ------ | ------- |
| `finance.command-bar` | Actions, rebuild controls, and pipeline warnings. |
| `finance.filters` | Committed URL filters for year, account, institution, owner identity, and source kind. |
| `finance.summary` | KPI strip for inflow, outflow, net, transaction count, ready count, and review count. |
| `finance.cashflow` | Monthly inflow, outflow, and net chart. |
| `finance.categories` | Category inflow, outflow, net, and count chart plus table. |
| `finance.subscriptions` | Recurring merchant and subscription lens from `finance_patterns`. |
| `finance.ledger-preview` | Rollup, ledger, import, and review drilldown tables. |
| `finance.export-health` | Export runs, validation status, and Beancount/Fava readiness. |

## Charting

Apache ECharts is the canonical chart library for finance analytics. The
browser uses Canvas rendering by default through treeshakable imports from
`echarts/core`.

The chart runtime registers:

- `CanvasRenderer`
- `LineChart`
- `BarChart`
- `PieChart`
- `GridComponent`
- `TooltipComponent`
- `LegendComponent`
- `DatasetComponent`
- `DataZoomComponent`

Server-rendered tables and KPIs remain the accessible baseline when JavaScript
is disabled.

## Analytics Output

`loadFinanceData()` returns:

- `cashflowSeries`: 12 monthly buckets for the selected year and filters
- `categoryBreakdown`: primary and secondary category totals
- `subscriptionPatterns`: parsed `finance_patterns` rows with recurring
  merchant details
- `exportHealth`: latest export status and ready, review, and blocked counts

Cashflow buckets must preserve direction semantics:

- income contributes to inflow
- expenses contribute to outflow
- net equals inflow minus outflow
- duplicate ledger entries are excluded
- empty years return 12 zero buckets

## Subscription Lens

The subscription lens reads `finance_patterns` rows where
`pattern_kind = "recurring_merchant"`. It does not invent hidden browser-side
heuristics when patterns are empty. Empty state should tell the operator to
rebuild finance knowledge after classification catches up.

The parsed summary should expose:

- `counterparty`
- `book`
- `transactionCount`
- `canonicalKeys`
- optional `cadence`
- optional `amountBand`
- optional `nextExpectedAt`
- optional `lastAmountMinor`

## Filter State

Committed URL keys:

- `tab`
- `year`
- `accountId`
- `institutionId`
- `ownerIdentityId`
- `sourceKind`
- committed chart date range
- committed category or subscription drilldown

Session-restored keys:

- chart zoom before commit
- hidden or visible series
- table sort
- scroll position
- expanded rows
- active subpanel

Ephemeral keys:

- hover
- brush drag
- crosshair
- focused input
- pending RPC state

## Realtime Refresh

Finance SSE events should refresh affected finance islands first. A ledger
rebuild refreshes analytics islands such as summary, cashflow, categories,
subscriptions, ledger preview, and export health. Job events refresh command and
status islands when they are finance related.

Full page main refresh is the fallback only when a requested island is missing
or unsupported for the current page.

## Deferred Work

Message analytics is deferred. Future specs may add timeline or
sender-recipient lenses, but this document only reserves the island and event
patterns needed to add them later.
