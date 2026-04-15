# Finance Import Artifacts

## Summary

zmail supports source-neutral finance imports from external extraction tools.

The first operator flow is external:

- Python companion scripts
- `claude -p` with `opus`
- artifact JSON written to disk or POSTed to zmail

zmail stores normalized extracted data plus provenance and hashes. Raw PDFs stay
 outside zmail in the first rollout.

## Artifact contract

- `schemaVersion = "finance-source-import.v1"`
- `sourceKind`
- `sourceFile`
- `artifactSha256`
- `extractor`
- `registrySuggestions`
- `documents`
- `transactions`
- `provenance`

## Import surfaces

- CLI: `pnpm finance:import <artifact.json>`
- HTTP: `POST /api/finance/imports`

## Stored tables

- `finance_import_runs`
- `finance_import_documents`
- `finance_import_transactions`
- `registry_suggestions`

## Safety rules

- imported registry suggestions do not write directly into canonical registry
  tables
- reconciliation decides whether a suggestion is:
  - `pending`
  - `applied`
  - `rejected`
  - `superseded`

