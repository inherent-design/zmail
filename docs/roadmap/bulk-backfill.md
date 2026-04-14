# Roadmap: Bulk Backfill

## Purpose

Batch-mode backfills are deferred until the live Gmail sync path is stable and the direct per-message pipeline is well understood.

This roadmap item is about batch or offline replay modes. It does not cover the active live historical backfill runtime used by the Gmail sync worker.

## Why Deferred

- the active product risk is correctness of live sync, freshness, and review semantics
- batch execution adds a second operational mode with different failure and trace patterns
- live direct inference is already sufficient for incremental synced corpora and operator workflows

## Future Bulk-Backfill Goals

- replay large historical corpora cheaply
- migrate prompt versions across old data
- reclassify stale data after schema upgrades
- support cost-aware overnight backfills

## Required Preconditions

- stable live sync and watcher behavior
- trustworthy content-hash freshness logic
- proven review and override semantics
- clear replay strategy for `classification_results` and `message_labels`

## Likely Work Items

- batch request builder
- batch result ingestion and reconciliation
- replay-safe prompt version migration
- rate and cost controls
- run-level observability and retry handling

## Non-Goals For The Current MVP

- active Batch API runtime path
- dual direct-vs-batch execution strategy
- batch-specific UI as a primary operator workflow
