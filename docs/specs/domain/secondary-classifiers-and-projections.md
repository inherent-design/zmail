# Secondary Classifiers and Projections

## Purpose

This document defines secondary classifiers and deterministic projection layers
for zmail vNext.

## Core Principles

- root classification remains the mailbox-wide review and routing contract
- secondary classifiers are additive and namespaced
- deterministic projections do not rewrite model history
- downstream materialization may depend on secondary heads and projection output

## Storage Model

### Result history

`message_secondary_results` stores append-only secondary result history.

Key fields:

- `message_id`
- `classifier_key`
- `schema_version`
- `job_id`
- `model`
- `prompt_version`
- `source`
- `result_json`
- `raw_response_json`
- `usage_json`
- `input_content_sha256`
- `input_registry_sha256`
- `created_at`

### Current heads

`message_secondary_heads` stores the current head per:

- `(message_id, classifier_key)`

Head fields:

- `secondary_result_id`
- `status`
- `low_confidence`
- `content_sha256`
- `registry_sha256`
- `updated_at`

Allowed statuses:

- `ready`
- `review`
- `stale`
- `blocked_parse_error`

## Active Secondary Classifier

Active classifier:

- `classifier_key = "finance_intel"`
- schema version: `finance-intel.v3`

## Review Classifier Heads

The review classifier is not a secondary classifier result overwrite path. It
persists separate append-only model output and current finding heads:

- `review_classification_results`
- `review_classification_heads`

Targets:

- `target_kind = "root_review"` for root `reviews` rows
- `target_kind = "finance_ledger_entry"` for ledger rows in `review` or
  `blocked`

Findings may request:

- manual review
- targeted `classify_root_messages`
- targeted `classify_finance_messages`
- mapping suggestions
- overseer signals

They must not mutate `message_secondary_heads`, `message_labels`,
`finance_ledger_entries`, or operator YAML directly. Finance review findings
are separate audit heads and are never promotion of secondary output into root
labels.

### Trigger rules

Root eligibility requires:

- current root label exists
- current root label schema is `message-label.v3`
- `rootLabel.finance.relevant === true`
- `rootLabel.finance.requiresFinanceIntel === true`

Parsed message behavior:

- when `messages.parse_status === "parsed"`, run `finance-intel.v3`
  extraction unless the current head is fresh

Parse-error backlog behavior:

- when `messages.parse_status === "error"`, do not skip backlog processing
- persist or refresh a `finance_intel` secondary head with status
  `blocked_parse_error`
- the blocked head uses schema `finance-intel.v3`
- the blocked result sets `ledgerReadiness.status = "blocked"` with reason
  `parse_error`
- refresh the blocked head when content hash, registry SHA, prompt version, or
  prompt SHA is stale

Targeted job behavior:

- `classify_finance_messages` requires parsed targets
- targeted jobs skip parse-error targets and record `meta.skipped[]` with reason
  `parse_status_not_parsed`

Skip when:

- root label is missing
- finance is not relevant
- finance intel is not required
- current finance head is fresh for content and registry inputs
- targeted parse-error message: skip with metadata
- backlog parse-error message: do not skip; write `blocked_parse_error`

### Freshness inputs

- `messages.content_sha256`
- org-local operator registry `registry_sha256`
- finance classifier prompt version
- finance classifier prompt SHA-256 of full prompt file contents
- explicit stale marking when root-label changes require downstream reevaluation

## `finance-intel.v3` Contract

Top-level fields:

- `schemaVersion`
- `messageKind`
- `actionability`
- `book`
- `ledgerReadiness`
- `transactionCandidates[]`
- `documentCandidates[]`
- `dedupe`
- `matchedRegistryRefs`
- `unresolvedEntityHints`
- `fieldConfidence`
- `confidence`
- `explanation`

### `book`

- `scope`
  - `personal`
  - `business`
  - `mixed`
  - `unknown`
- `businessUsePercent`
  - integer `0..100`, required when `scope = "mixed"`
- `taxTreatmentHint`
- `evidence`

### `ledgerReadiness`

- `status`
  - `exportable`
  - `review`
  - `not_ledger`
  - `blocked`
- `reasons[]`
- `requiredFixes[]`

### `transactionCandidates[]`

- `kind`
- `direction`
- `amount`
- `currency`
- `occurredAt`
- `postedAt`
- `clearedAt`
- `merchantOrCounterparty`
- `ownerIdentityRef`
- `financialAccountRef`
- `institutionRef`
- `categoryPrimary`
- `categorySecondary`
- `statementRefHint`
- `taxRelevanceHint`
- `book`
- `businessUsePercent`
- `beancount`
  - `debitAccount`
  - `creditAccount`
  - `currency`
  - `mappingKey`
  - `confidence`
  - `metadata`
- `dedupe`
  - `externalTransactionId`
  - `statementRowId`
  - `normalizedComposite`
  - `emailEvidenceKey`
- `externalTransactionId`
- `evidence`

### `documentCandidates[]`

- `documentType`
- `issuer`
- `externalId`
- `statementPeriodStart`
- `statementPeriodEnd`
- `statementOpeningBalance`
- `statementClosingBalance`
- `statementCurrency`
- `dueAt`
- `taxYear`
- `accountRefHint`
- `institutionRefHint`
- `sourceDocumentRef`
- `attachmentRefs`
- `evidence`

### `fieldConfidence`

`fieldConfidence` contains per-field confidence scores used by ledger staging.
At minimum:

- `book`
- `amount`
- `date`
- `counterparty`
- `accountMapping`
- `category`
- `dedupe`

Rules:

- candidates missing amount, date, counterparty, account mapping, book scope, or
  dedupe evidence are not exportable
- `mixed` book scope is exportable only with an explicit `businessUsePercent`
- registry ids may only reference matched registry context
- Beancount `mappingKey` values may only reference matched account mappings in
  prompt context
- invalid or missing account mapping prevents `ledgerReadiness.status =
  "exportable"`
- imported statement/CSV/OFX rows are higher authority than email-only
  candidates when dedupe keys collide

## Deterministic Projection Layer

Operator-controlled deterministic projection lives on top of root and secondary
results.

Storage:

- `classification_rule_sets`
- `classification_rules`
- `message_category_assignments`
- `message_category_assignment_heads`

Operator files:

- `root-taxonomy.yaml`
- `finance-taxonomy.yaml`
- `rules.yaml`

Inputs:

- root label
- sender/domain/account metadata
- attachment metadata
- current finance-intel result
- registry matches

Outputs:

- projected primary category
- projected secondary category
- projected finance primary category
- projected finance secondary category
- projection source:
  - `root_model`
  - `overlay_rule`
  - `finance_secondary`
  - `pdf_import`

## Rebuild Semantics

- taxonomy or rules changes rebuild deterministic projections immediately
- root prompt/schema changes queue root backlog reclassification
- finance taxonomy changes rebuild finance projections and rollups without
  rewriting secondary result history

## Boundaries

- secondary classifiers do not replace `message-label.v3`
- deterministic projections do not overwrite secondary result history
- finance knowledge materialization consumes current finance heads and imported
  artifacts, not arbitrary historical secondary rows
- review classifier findings do not overwrite secondary-result heads; they
  enqueue targeted work or surface operator actions

## Failure Modes

- invalid secondary payload: head remains stale or blocked and is eligible for
  reprocessing
- registry import changes: current finance heads become stale
- projection input mismatch: assignment heads become stale and rebuild

## Out Of Scope

- silent promotion of secondary outputs into root labels or manual review
  decisions
- secondary classifiers unrelated to an explicitly specified domain contract
- new visible opportunity, relationship, spam/fatigue, travel, or legal lenses
  in this finance rewrite
