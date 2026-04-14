# Roadmap: Semantic Search and Attachments

## Purpose

Attachment extraction, embeddings, semantic retrieval, and cross-message synthesis are out of scope for the current live-sync MVP. This document captures the future direction without inflating the active runtime contract.

## Future Areas

### Attachment Extraction

- extract text from PDFs and office documents
- keep extracted text separate from raw binary storage
- maintain provenance from extracted chunks back to attachment metadata

### Embeddings

- generate embeddings for normalized message bodies
- later extend to attachment text chunks
- version embeddings by model and extraction pipeline

### Retrieval

- semantic search over message bodies
- semantic search over extracted attachment content
- thread-aware and account-aware retrieval filters

### Synthesis

- account-level topic summaries
- relationship summaries
- finance rollups with evidence chains
- cross-email opportunity and risk synthesis

## Preconditions

- live Gmail sync must be stable
- content-hash freshness and reclassification logic must be correct
- raw RFC822 and attachment provenance must remain intact
- review semantics for the current label contract must already be trustworthy

## Dependency On Message Model V2

Search and retrieval should not treat `body_text_normalized` as the final
canonical text surface.

Before retrieval semantics are treated as stable:

- V2 body extraction fields should land so primary and forwarded content can be
  indexed deliberately
- canonical conversation identity should land so retrieval can group or filter
  by Gmail conversation rather than `thread_key`
- attachment extraction should preserve provenance back to both attachment
  metadata and parent message/conversation identity

## Expected New Components

- attachment extraction workers
- embedding storage and migration strategy
- retrieval indexes
- evidence-oriented UI surfaces

## Deferred Decisions

- embedding provider choice
- vector store choice
- chunking strategy
- attachment extraction scope and cost controls
