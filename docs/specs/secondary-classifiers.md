# Secondary Classifiers

## Summary

zmail keeps the root classifier separate from domain-specific secondary
classifiers.

The active root contract is `message-label.v2`. Secondary classifiers remain
additive analyses with their own freshness, storage, and promotion rules.

Secondary classifiers:

- never overwrite the root label head
- have their own result history and current head tables
- can have freshness inputs beyond message content
- can drive domain-specific knowledge materialization

## Storage model

### `message_secondary_results`

Append-only result history per classifier run.

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

### `message_secondary_heads`

Current head per `(message_id, classifier_key)`.

Key fields:

- `secondary_result_id`
- `status`
- `low_confidence`
- `content_sha256`
- `registry_sha256`
- `updated_at`

Allowed first-rollout statuses:

- `ready`
- `review`
- `stale`
- `blocked_parse_error`

## Freshness

Secondary freshness is independent from the root label head.

Current finance secondary freshness inputs:

- `messages.content_sha256`
- operator registry `registry_sha256`
- explicit stale marking when the current root label changes
- category and finance taxonomy changes can trigger downstream projection or
  rollup rebuilds without rewriting secondary history

## Execution contract

Secondary classifiers:

- run asynchronously in worker jobs
- may be queued by account backlog or targeted operator actions
- should be conservative and idempotent
- must tolerate re-runs after message or registry changes

## First active classifier

- `classifier_key = "finance_intel"`
- schema version: `finance-intel.v2`

It is triggered only for messages whose current root label is
finance-relevant and whose parse status is not `error`.

Current secondary-adjacent jobs:

- `classify_finance_backlog`
- `rebuild_finance_knowledge`
- `rebuild_finance_rollups`
- `reconcile_registry_suggestions`
- `import_finance_artifact`
- `rebuild_category_assignments`
