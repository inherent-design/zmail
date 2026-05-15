# Tax and Business Reporting

## Purpose

This document defines operator workpaper packages for personal tax review and
quarterly inherent.design business review. These packages organize finance
evidence from zmail; they are not tax filing software, tax advice, or direct
filing artifacts.

## Scope

Covered here:

- annual personal tax information package
- quarterly inherent.design business package
- evidence package files for operator review
- form-like schedule summaries for review workflows
- readiness gates before accepted totals are generated

Out of scope here:

- electronic filing
- direct IRS or state tax form submission
- tax advice or legal interpretation
- direct edits to Beancount files maintained outside zmail
- new finance ingestion paths

## Data Sources

Reporting reads existing finance materializations and provenance:

- `finance_ledger_entries`
- `finance_ledger_entry_sources`
- `finance_import_documents`
- `finance_import_transactions`
- `finance_yearly_rollups`
- `finance_yearly_subcategory_rollups`
- `finance_export_runs`
- `finance_export_items`
- registry identities, financial accounts, institutions, sender rules, and
  account mappings

Report generators must not read raw RFC822 bodies. Message ids, source ids,
import ids, hashes, and safe source provenance are valid evidence references.

## Counting Rules

Accepted totals include only rows that satisfy strict reporting readiness.

Rules:

- `ready` rows count in accepted totals
- `review` rows appear in review totals, evidence lists, and gap summaries
- `blocked` rows appear only in blocker lists
- `duplicate` rows appear only as suppressed provenance
- rows with `direction = "both"`, `direction = "neither"`, or
  `direction = "unknown"` do not count in accepted income or expense totals
- rows without resolved account mappings do not count in accepted totals
- rows without amount, currency, date, counterparty, book scope, or dedupe key
  do not count in accepted totals

Planning dashboards may show `review` rows so the operator can estimate scale.
Tax and business workpaper accepted totals must use `ready` rows only.

## Book Semantics

Book scope follows transaction purpose, not source account ownership.

Rules:

- business-purpose rows paid from personal accounts may be `business`
- personal-purpose rows paid from business accounts must not become business
  merely because the account is business-owned
- ambiguous shared-use rows use `mixed` only when `businessUsePercent` is
  present
- `mixed` rows without `businessUsePercent` remain blocked
- source account ownership remains evidence and should appear in review
  sidecars when it conflicts with purpose

This makes personal-account business expenses visible for inherent.design
without treating all personal-account activity as business activity.

## Output Packages

The personal annual package path is:

```txt
operator/reports/tax/personal/<year>/<runId>/
```

The inherent.design quarterly package path is:

```txt
operator/reports/tax/business/inherent-design/<year>-Q<quarter>/<runId>/
```

Each package writes:

```txt
summary.md
summary.json
ledger.csv
review.csv
evidence.csv
forms/
  form-values.json
  personal-tax-workpaper.md
  quarterly-business-workpaper.md
  schedule-c-workpaper.md
  schedule-se-workpaper.md
  schedule-a-workpaper.md
  form-8949-workpaper.md
```

`summary.md` is the human review entrypoint.

`summary.json` is the machine-readable report manifest and aggregate payload.
The manifest includes `readiness` gates and a `snapshot` object with total
ledger row count, selected-period ledger row count, accepted row count, review
row count, max ledger `updated_at`, and open finance jobs at generation.

`ledger.csv` contains accepted `ready` rows only.

`review.csv` contains rows that may affect the report after operator repair.

`evidence.csv` links accepted and review rows back to zmail provenance without
embedding raw message bodies or secret material.

`forms/form-values.json` contains candidate form values with schema
`tax-form-values.v1`, readiness gates, source ledger entry ids, and manual
inputs required. `forms/*.md` contains form-like schedule summaries. The
personal annual package uses `forms/personal-tax-workpaper.md`. The
inherent.design quarterly package uses
`forms/quarterly-business-workpaper.md`. Annual packages also write Schedule C,
Schedule SE, and Schedule A workpapers. Form 8949 workpapers are written only
when investment disposition evidence exists. These summaries are workpapers for
human review and must not claim to be filing-ready tax forms.

## Annual Personal Package

The annual personal package groups one calendar year of personal-scope finance
evidence.

Accepted totals include:

- personal income
- personal expenses by finance category
- personal tax documents by tax year and issuer
- personal tax notices and payments
- personal deductions or potentially deductible categories when supported by
  taxonomy, account mappings, or explicit operator review

Review sections include:

- personal rows still in `review`
- blocked personal rows
- missing account mappings
- non-export directions
- possible business-purpose rows paid through personal accounts
- imported tax documents with incomplete ownership or tax year metadata

## Quarterly inherent.design Package

The quarterly inherent.design package groups business-purpose rows for one
calendar quarter.

Accepted totals include:

- business income
- business expenses by finance category
- business software and service costs
- payroll and contractor payments
- taxes and licenses, excluding rows categorized as `estimated_tax`
- transfers only when mapping and direction make them countable
- mixed-use rows only by their explicit business allocation

Review sections include:

- business rows still in `review`
- blocked business rows
- personal-source rows classified as business
- mixed rows missing `businessUsePercent`
- rows with missing account mappings
- rows whose category conflicts with account mapping or purpose evidence

## Readiness Audit

Before generating accepted totals for a year or quarter, the audit must report:

- row counts by year, status, book, and source authority
- source split between email-derived and imported finance artifacts
- required-field gaps for amount, date, counterparty, account mapping, and mixed
  allocation
- category totals by book and status
- account mapping count
- registry file readiness
- export run state
- open jobs that may change finance results

The audit uses read-only database access. Merchant, counterparty, subject, and
body samples are excluded unless the operator explicitly approves a sampled
evidence review.

## Current 2025 Gate

The live 2025 data is not ready for accepted report totals yet.

Count-only baseline from 2026-04-20:

- 383 rows for 2025
- 340 rows in `review`
- 43 rows in `blocked`
- 0 rows in `ready`
- 0 account mappings
- 0 imported finance artifacts
- 0 export runs

The next required operator action is account mapping and registry repair,
followed by finance knowledge and rollup rebuilds.

If no ready rows exist, report generation still writes an audit/review package.
`ledger.csv` is empty, `review.csv` and blocker sections contain the actionable
rows, and accepted totals remain gated.

## Safety Rules

Generated packages must not contain:

- raw RFC822 bodies
- OAuth tokens
- WorkOS tokens or cookies
- full account numbers
- bank credentials
- API keys
- decrypted secret values

Generated packages may contain:

- zmail ids
- canonical keys
- source kinds
- import ids
- message ids
- hashes
- masked account references
- account last4 values when already present in registry evidence

## Interfaces

Browser RPC:

- `POST /rpc/finance/tax/personal`
  - body: `{ "year": 2025, "outDir": "personal-2025" }`
  - queues `generate_tax_personal_package`
- `POST /rpc/finance/tax/business/inherent-design`
  - body: `{ "year": 2025, "quarter": 1, "outDir": "inherent-design-2025-q1" }`
  - queues `generate_tax_business_quarter_package`

Job records:

- `generate_tax_personal_package`
- `generate_tax_business_quarter_package`

Report run status lives in `tax_report_runs` with:

- status `complete` or `audit_only`
- selected year
- selected quarter when applicable
- business slug when applicable
- output directory
- manifest JSON
- validation JSON

CLI commands should mirror the existing `mise run finance:export` style and
resolve org runtime context before reading finance rows. They must enqueue the
same job kinds or call the same package generator used by worker jobs.

## Failure Modes

- no `ready` rows: write only audit/review package output, not accepted totals
- missing mappings: route rows to `review.csv` or blocker summaries
- active jobs: write the package as an `audit_only` snapshot with readiness
  blockers
- duplicate rows: retain suppressed provenance and keep duplicates out of
  accepted totals
- unsafe evidence: omit unsafe fields and record redacted provenance

## Browser Workflow

Tax and business report queue actions return mutation envelopes that invalidate
finance and runs data. Report manifests and validation JSON render through
`DataInspector`. Export and report output directories are org-local and never
public static paths.
