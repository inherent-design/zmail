# Operator Registry

## Summary

The operator registry is the local editable source of truth for known
identities, institutions, financial accounts, and sender matching rules used by
secondary finance classification.

Editable source:

- `data/operator/registry/identities.yaml`
- `data/operator/registry/institutions.yaml`
- `data/operator/registry/financial-accounts.yaml`
- `data/operator/registry/sender-rules.yaml`

Runtime cache:

- `registry_identities`
- `registry_institutions`
- `registry_financial_accounts`
- `registry_sender_rules`
- `registry_import_state`
- `registry_suggestions`

## Safety rules

Allowed facts:

- display names
- aliases
- personal or business identity kind
- email addresses
- domains
- institution names
- account labels
- masked account identifiers
- account last4
- ownership and tax-owner hints
- sender and domain matching rules

Do not store:

- full account numbers
- API keys
- OAuth secrets
- bank credentials

## Import model

Imports are transactional and fail closed on schema errors.

Import side effects:

- replace operator-authored cache rows
- compute combined `registry_sha256`
- upsert `registry_import_state`
- mark current finance secondary heads stale

Rows authored by automatic suggestion reconciliation are stored separately with
`source_kind = "suggestion"` so operator imports do not delete them.

## Suggestions and reconciliation

Automatic discovery from imported PDFs or statements does not write directly
into canonical registry rows.

Instead:

- external extractors emit `registrySuggestions`
- zmail stores them in `registry_suggestions`
- reconciliation can auto-apply high-confidence non-conflicting suggestions
- low-confidence or conflicting suggestions remain pending/reviewable

Current suggestion statuses:

- `pending`
- `applied`
- `rejected`
- `superseded`

## Future enrichment

Future non-API sources should feed this same registry and knowledge system:

- CSV exports
- OFX / QFX
- statement PDFs and parsed statement metadata
