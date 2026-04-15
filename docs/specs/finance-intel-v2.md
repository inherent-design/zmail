# Finance Intel V2

## Summary

`finance-intel.v2` is the active finance secondary classifier in zmail.

It reads one finance-relevant message at a time and emits conservative,
message-scoped structured finance intelligence for downstream rollups,
knowledge materialization, and PDF-import reconciliation.

## Trigger

Run only when:

- a current root `message-label.v2` exists
- `rootLabel.finance.relevant === true`
- `messages.parse_status === "parsed"`

Skip when:

- parse status is `error`
- the current root label is missing
- the current `finance_intel` head is fresh for:
  - `messages.content_sha256`
  - operator registry `registry_sha256`

## Inputs

- `sender_address`
- `subject`
- `received_at`
- `body_text_normalized`
- attachment summary
- current root `message-label.v2`
- matched operator registry facts
- finance taxonomy from `data/operator/classification/finance-taxonomy.yaml`

## Output schema

- `schemaVersion = "finance-intel.v2"`
- `messageKind`
- `actionability`
- `transactionCandidates[]`
- `documentCandidates[]`
- `matchedRegistryRefs`
- `unresolvedEntityHints`
- `confidence`
- `explanation`

### `transactionCandidates[]`

- `kind`
- `direction`
- `amount`
- `currency`
- `occurredAt`
- `merchantOrCounterparty`
- `ownerIdentityRef`
- `financialAccountRef`
- `institutionRef`
- `categoryPrimary`
- `categorySecondary`
- `statementRefHint`
- `taxRelevanceHint`
- `evidence`

### `documentCandidates[]`

- `documentType`
- `issuer`
- `externalId`
- `statementPeriodStart`
- `statementPeriodEnd`
- `dueAt`
- `taxYear`
- `accountRefHint`
- `institutionRefHint`
- `attachmentRefs`
- `evidence`

## Semantic rules

- promotions and generic alerts may still be root-finance, but should usually
  use `actionability = "none"`
- registry ids may only be emitted when they are present in the matched
  registry context
- null is preferred over invention
- categorization should use the finance taxonomy rather than free-form category
  strings
- the classifier stays per-message and does not merge across conversations or
  accounts

## Downstream use

Current downstream consumers:

- message detail finance panels
- category overlay projection
- finance knowledge rebuild
- yearly rollup rebuild

