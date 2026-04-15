# Multi-Lens Analysis Architecture

## Summary

zmail keeps the root classifier and review
contract. New lenses are added as secondary classifiers with independent
freshness, storage, and promotion rules.

This means:

- the root classifier remains the primary mailbox-wide routing layer
- new lenses are additive, not in-place mutations of the root contract
- secondary outputs get independent freshness
- promotion into operator-facing UI is explicit, not implicit

## Active shape

- root classifier
  - `message-label.v2`
  - mailbox-wide bucketing, review, and overseer inputs
- secondary classifiers
  - stored in `message_secondary_results`
  - current heads stored in `message_secondary_heads`
- knowledge layers
  - domain-specific materialized outputs derived from secondary heads
  - first domain: finance

## Promotion rules

Secondary outputs are not automatically promoted into the root classifier or the
main mailbox list.

Promotion is explicit:

- root UI remains bucket-first unless a secondary surface is intentionally added
- secondaries may get dedicated detail panels or dedicated pages
- materialized knowledge tables are separate operator-facing surfaces
- no secondary lens silently rewrites `message-label.v2`

## Candidate future lenses

- spam / fatigue
- opportunity / follow-up
- topical clustering
- relationship analysis
- temporal patterns
- travel or logistics
- legal / compliance

## Constraints

- Gmail sync and message freshness must remain stable
- root review semantics must remain predictable
- secondaries must tolerate re-runs and stale invalidation cleanly
- conversation-aware work should use Gmail conversation identity, not `thread_key`
- new knowledge layers should remain domain-specific until a real shared shape
  emerges
- deterministic overlay layers should project categories from model outputs
  rather than mutating model history
