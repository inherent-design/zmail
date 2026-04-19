# Future Boundaries

## Purpose

This document preserves meaningful deferred product intent without letting old
roadmap notes act as active architecture truth.

Everything here is explicitly out of the active contract until promoted into an
owning spec.

## Deferred: Bulk or Offline Backfill

Potential future area:

- cost-aware replay or overnight reprocessing of large historical corpora

Prerequisites:

- stable live sync
- trustworthy content-hash freshness
- clear replay semantics for classification history and current heads

Not active now:

- batch execution mode
- dual direct-vs-batch runtime

## Deferred: Semantic Search and Attachments

Potential future area:

- attachment text extraction
- embeddings
- semantic retrieval
- cross-message synthesis

Prerequisites:

- stable message model
- reliable body extraction
- preserved attachment provenance
- trustworthy review and freshness semantics

Not active now:

- vector store
- embedding pipeline
- semantic search UI

## Deferred: Additional Secondary Lenses

Potential future areas:

- spam or fatigue
- opportunity and follow-up
- topical clustering
- relationship analysis
- travel or legal domain lenses

Promotion rule:

- no new lens becomes active until it has its own explicit secondary classifier
  contract and downstream ownership model

## Boundary Rule

Deferred work does not define the active runtime.

It may influence future planning, but it does not override platform or domain
specs in `docs/specs/`.
