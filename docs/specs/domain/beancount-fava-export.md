# Beancount and Fava Export

## Purpose

This document defines the strict Beancount 3 and Fava export contract for
zmail finance data.

## Scope

Covered here:

- export CLI
- output package layout
- account mapping requirements
- strict ledger eligibility
- unresolved sidecars
- validation

## CLI Contract

Canonical CLI:

```bash
pnpm finance:export --org <orgId> --out <dir> [--year YYYY] [--strict] [-f|--force]
```

Rules:

- `--org <orgId>` is required
- `--out <dir>` is required
- `--year YYYY` limits generated entries to one calendar year
- `--strict` is the default behavior and may be explicit
- existing `--out` directories fail closed by default
- `-f` / `--force` explicitly allows overwriting an existing export target
- the command resolves the org runtime before reading any finance rows

## Browser Export Contract

The browser `POST /rpc/finance/export` flow is narrower than the CLI:

- `outDir` is optional
- omitted `outDir` writes under the active org runtime export root:
  `operator/exports/finance/<orgId>/<exportRunId>/`
- supplied `outDir` must be a relative subpath under
  `operator/exports/finance/`
- absolute paths and `..` traversal are rejected before a job is queued

This keeps browser-triggered exports inside the org runtime boundary. Operators
who need an arbitrary filesystem target should use the CLI with explicit
`--org` and `--out`.

The finance page export panel must show:

- output directory
- validation state
- latest package manifest
- Fava smoke command:
  `mise run finance:fava -- <export-dir>`

When the selected period has zero `ready` rows, the browser may still queue an
export job, but the UI must warn that the package is audit-only and not an
accepted ledger export.

## Output Package

The export writes:

```txt
<out>/
  main.beancount
  accounts.beancount
  generated/
    <year>.beancount
  raw/
    zmail-finance-export.json
  review/
    unresolved.csv
  documents/
    ...
```

`main.beancount` includes `accounts.beancount` and generated yearly files.

`accounts.beancount` contains required `open` directives for exported accounts.

`generated/<year>.beancount` contains balanced transaction and document
directives.

`raw/zmail-finance-export.json` contains full export provenance and all staged
rows, including rows not exported to Beancount.

`review/unresolved.csv` contains rows blocked from strict export with reasons.

## Account Model

zmail exports one Beancount package, not separate personal and business ledgers.

Personal and business separation is represented by the account tree plus
metadata:

- `Assets:Personal:*`
- `Assets:Business:*`
- `Liabilities:Personal:*`
- `Liabilities:Business:*`
- `Income:Personal:*`
- `Income:Business:*`
- `Expenses:Personal:*`
- `Expenses:Business:*`
- `Expenses:Mixed:*` only when explicit allocation metadata is present

Every exported row requires a resolved Beancount account mapping.

Mappings may come from:

- operator registry/account mapping rows
- imported artifact `accountMappingKey`
- deterministic finance taxonomy rules
- manual future review output

Classifier free text alone is not enough to create an export account.

## Pre-Export Readiness

Strict export is useful only when the selected period has nonzero
`finance_ledger_entries.status = "ready"` rows. A package with zero ready rows
is still valid as an audit artifact, but it is not a meaningful ledger export.

Readiness checks before export should report:

- ready, review, blocked, and duplicate row counts for the selected period
- account mapping coverage
- rows missing amount, currency, date, counterparty, dedupe key, or book scope
- rows with `book = "mixed"` and no `businessUsePercent`
- rows with `direction = "both"`, `direction = "neither"`, or
  `direction = "unknown"`

Missing account mappings keep rows out of `.beancount`. The exporter may still
write those rows to raw and review sidecars so operators can repair mappings and
rebuild finance knowledge.

## Transaction Metadata

Exported transactions include stable zmail metadata:

- `zmail_book`
- `zmail_confidence`
- `zmail_source`
- `zmail_canonical_key`
- `zmail_message_id`
- `zmail_export_run_id`

Transactions include a Beancount link:

```txt
^zmail-<canonical-key>
```

The canonical key is normalized to Beancount link-safe characters before
rendering.

## Strict Export Eligibility

A staged row may enter `.beancount` only when:

- amount is known
- currency is known
- direction is `income` or `expense`
- direction is not `both`, `neither`, or `unknown`
- date is known
- counterparty/payee is known
- book scope is `personal`, `business`, or `mixed`
- mixed scope has `businessUsePercent`
- source account mapping is known
- offset account mapping is known
- dedupe key is known
- resulting postings balance
- confidence is above the configured export threshold

Rows failing any rule go to sidecars, not ledger output.

## Documents

When a source document path is available and safe to reference, export may emit
Beancount `document` directives.

Rules:

- raw RFC822 email paths are not Beancount documents
- imported PDF or statement paths may become documents
- missing document files do not block ledger export but must be noted in raw
  sidecar provenance

Fava can load the generated package with:

```bash
mise run finance:fava -- <export-dir>
```

## Validation

Export validation runs in this order:

1. internal renderer checks balanced postings and deterministic output
2. `bean-check main.beancount` when available
3. Fava manual smoke may run `fava main.beancount`

If `bean-check` is unavailable, tests must assert deterministic syntax output
and record the external validation as skipped.

## Failure Modes

- no exportable rows: write package with empty generated file and sidecars
- unresolved mappings: row goes to `review/unresolved.csv`
- duplicate canonical keys: import-backed row wins; email-only row becomes
  evidence or unresolved duplicate
- write failure: fail closed without mutating existing export package in place
- overwrite protection: an existing output directory is treated as a write
  hazard unless `--force` is explicit

## Out Of Scope

- automatic insertion into an existing hand-maintained Beancount file
- Fava API writes
- editing source files through zmail
- broad attachment extraction

## Current Implementation Notes

The current target implementation is expected to:

- read `finance_ledger_entries` as the sole Beancount transaction source
- export only `status = "ready"` rows into `.beancount`
- write `review`, `blocked`, and `duplicate` rows to raw/review sidecars
- persist `finance_export_runs` and `finance_export_items`
- run `bean-check` when available and record `skipped` when unavailable

Remaining known drift:

- document directives are emitted only when source document paths are available
  in staged provenance
- statement parity checks are still staging-side validation work
- implementation must explicitly keep `both`, `neither`, and `unknown`
  directions in sidecars if any such row reaches `status = "ready"`

## Browser Workflow

Export queue actions return mutation envelopes targeting export run state,
export-health, and lane islands. Export manifests and validation JSON render
through `DataInspector`. Redacted manifest data may be copied from the browser;
raw secrets, tokens, and full account numbers are not rendered.
