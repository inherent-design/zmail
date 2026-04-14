# Roadmap: Multi-Lens Analysis

## Purpose

The active runtime classifies mail with the `finance/social/risk/routing` contract. Broader analysis lenses are future work and must not be treated as current product contract.

## Candidate Lenses

- spam likelihood
  - unsubscribe candidates
  - sender fatigue
  - template-heavy bulk mail
- opportunity value
  - missed leads
  - unanswered asks
  - time-sensitive follow-ups
- topical clustering
  - recurring subject areas
  - projects
  - communities
- relationship analysis
  - personal vs professional ties
  - reciprocity
  - response patterns
- temporal analysis
  - recurring cycles
  - spending or opportunity seasonality
  - long-gap reconnect signals

## Preconditions

Before adding these lenses:

- Gmail live sync must remain stable
- message freshness by content hash must stay correct
- review and override semantics must remain predictable
- operator UI must have room for more than the current bucket-first model

## Likely Implementation Shape

- preserve `message-label.v1` as the current stable contract
- add new prompt versions rather than mutating the existing contract in place
- store new lens outputs as additive result versions first
- promote new fields into the current label surface only after review and stability
- once Message Model V2 lands, any conversation-aware analysis should key off
  Gmail conversation identity rather than `thread_key`
- content-hash freshness should remain the invalidation mechanism for lens
  outputs

## Non-Goals For This Document

- final schemas
- model choices
- UI layouts
- rollout timing
