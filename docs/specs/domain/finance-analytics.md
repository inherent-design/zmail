# Finance Analytics

## Purpose

This document defines the first finance analytics surface for zmail vNext.

## Scope

The MVP is an operator-dense instrument panel focused on:

- cashflow analytics by month
- category inflow, outflow, and net pressure
- recurring merchant and subscription patterns
- ledger preview and drilldown tables
- readiness workbench for close blockers and freshness
- YAML-backed account mapping repair
- Beancount/Fava export status
- personal and inherent.design package jobs
- review classifier findings that affect finance close

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
- `finance_account_mappings`
- `review_classification_heads`
- `tax_report_runs`

Finance analytics may read review, mapping, job, and report state, but it must
derive chart math from ledger, rollup, pattern, and export tables.

## Page Islands

The finance page owns these islands:

| Island | Purpose |
| ------ | ------- |
| `finance.command-bar` | Actions, rebuild controls, and pipeline warnings. |
| `finance.filters` | Committed URL filters for year, account, institution, owner identity, and source kind. |
| `finance.lanes` | Finance-relevant lane state for finance LLM, review LLM, materialization, export/report, and overseer work. |
| `finance.summary` | KPI strip for inflow, outflow, net, transaction count, ready count, and review count. |
| `finance.cashflow` | Monthly inflow, outflow, and net chart. |
| `finance.categories` | Category inflow, outflow, net, and count chart plus table. |
| `finance.subscriptions` | Recurring merchant and subscription lens from `finance_patterns`. |
| `finance.overview.rollups` | Active overview tab rollup table. |
| `finance.readiness` | Active readiness workbench tab. |
| `finance.ledger` | Active ledger drilldown tab. |
| `finance.imports` | Active imports tab for documents and imported transactions. |
| `finance.mappings` | Active mapping candidate table and YAML-backed mapping editor tab. |
| `finance.review` | Active review classifier and ledger review tab. |
| `finance.tax` | Active tax and business package tab. |
| `finance.export-health` | Export runs, tax/report runs, validation status, and Beancount/Fava readiness. |

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
- `readiness`: status counts, missing-field counts, mapping coverage, open jobs,
  and classifier freshness
- `registrySuggestions`: pending and applied registry suggestions, including
  finance mapping candidates
- `reviewFindings`: current review classifier heads for finance targets
- `taxReportRuns`: package run status, readiness blocker counts through the
  manifest, and manifest/validation data

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
the active tab island, and lane status. Pattern rebuilds refresh subscription,
summary, and lane islands. Review classifier completion refreshes finance lane
status and the active review or readiness tab when visible. Job events refresh
command and lane islands when they are finance, registry, review, export, or tax
related.

SSE-triggered island refreshes do not fall back to a full main refresh. Explicit
user actions may request a same-page main fallback when the action cannot be
represented as island-only state.

## Deferred Work

Message analytics is deferred. Future specs may add timeline or
sender-recipient lenses, but this document only reserves the island and event
patterns needed to add them later.

## Workflow Targets

Finance analytics pages expose keyed nodes for ledger rows, review ledger rows,
mapping candidates, review findings, upload runs, import runs, export runs, and
tax report runs. Mutation envelopes refresh the smallest safe target first and
fall back to parent islands for user actions when a node is absent.

Ledger override editors submit strict patch fields and relationship fields.
Successful changes refresh affected row nodes, readiness, summary, lanes, and
analytics islands.
