# Message Model

## Purpose

This document defines the stable message and source model for zmail vNext.

It replaces the earlier transition-era “message model v2” proposal and should
be treated as the active target contract.

## Core Model

The active corpus is a Gmail-only mirror stored inside one org-local database.

Core entities:

- `accounts`
- `conversations`
- `messages`
- `message_sources`
- `attachments`

## Identity Model

### Message row identity

- `messages.id`
  - org-local primary key
  - never exposed as cross-org stable identity

### Header identity

- `messages.message_id`
  - RFC822 `Message-ID`
  - descriptive and useful for evidence/debugging
  - not the canonical sync dedupe key

### Source identity

- `message_sources.remote_message_id`
  - Gmail message identity per account
  - canonical sync dedupe key within an account

- `message_sources.remote_thread_id`
  - Gmail conversation identity per account
  - canonical conversation grouping input

## Conversation Model

- `conversations.gmail_thread_id` is the canonical conversation identity input
- `messages.conversation_id` points to the account-local conversation row
- `messages.thread_key` remains a heuristic fallback and compatibility field,
  not the primary conversation identity contract

## Time Model

- `messages.received_at`
  - user-facing message timestamp
- `messages.ingested_at`
  - time the local mirror persisted or refreshed the parsed content
- `messages.created_at`
  - row creation time
- `message_sources.first_seen_at` / `last_seen_at`
  - source observation timestamps

## Body Model

Message body fields:

- `body_text_primary`
- `body_text_forwarded`
- `body_text_normalized`
- `snippet`
- `body_extraction_strategy`
- `parse_status`
- `parse_error_reason`
- `token_estimate`

Rules:

- `body_text_normalized` is the downstream default text surface for moderation,
  root classification, and overview UI
- `body_text_primary` is the main human-authored body when extraction succeeds
- `body_text_forwarded` stores separated forwarded or quoted content when
  available
- `snippet` must never be a sentinel placeholder such as `undefined`, `null`,
  or literal HTML

## Parse Status

Active parse states:

- `parsed`
- `error`

Rules:

- parse errors are non-fatal to corpus persistence
- parse errors still preserve account/source/raw MIME state
- downstream secondary work that requires parsed bodies must skip or explicitly
  mark parse-blocked state

## Freshness Hashes

### Raw hash

- `message_sources.raw_sha256`
  - raw RFC822 byte hash
  - used to detect whether a saved source needs re-parse

### Content hash

- `messages.content_sha256`
  - parsed-content hash
  - used to determine moderation, root label, secondary head, and deterministic
    projection freshness

## Source Model

`message_sources` represent account-local source observations.

Key fields:

- `remote_message_id`
- `remote_thread_id`
- `imap_uid`
- `uidvalidity`
- `mailbox`
- `raw_rfc822_path`
- `raw_sha256`
- `state`

Active source states:

- `active`
- `tombstoned`

## Current Invariants Kept In vNext

Because the active provider model remains Gmail-only:

- one stored message row maps to one stored source row in the normal ingest path
- every active source belongs to one account in one org DB
- every current conversation is account-local

If a future provider model changes these invariants, the spec must be revised
explicitly.

## Downstream Dependencies

Message rows feed:

- moderation
- root classification through `message-label.v3`
- finance secondary classification through `finance-intel.v3`
- deterministic category projection
- overseer profile generation
- finance knowledge materialization
- strict Beancount/Fava export staging

## Finance Evidence Package

The finance model rewrite does not broaden ingestion beyond Gmail and does not
promote attachment text extraction into the active contract.

Instead, finance classification receives a minimal evidence package assembled
from existing message/source rows:

- `messageId`
- `accountId`
- `conversationId`
- `receivedAt`
- sender address and sender display name
- subject
- normalized body text and `messages.content_sha256`
- source ids, including Gmail `remote_message_id`, `remote_thread_id`,
  `imap_uid`, `uidvalidity`, and mailbox
- raw RFC822 provenance: `raw_rfc822_path` and `raw_sha256`
- attachment metadata only:
  - attachment id
  - filename
  - MIME type
  - size
  - inline flag

Rules:

- attachment text is not extracted in this contract
- classifiers may infer document presence from attachment metadata and body
  text, but cannot claim attachment contents unless an imported artifact later
  supplies that evidence
- raw RFC822 paths and hashes are provenance for repair/export sidecars, not
  Beancount document paths
- finance export may include message/source ids as metadata, but must not embed
  raw email bodies in `.beancount` files

## Failure Modes

- stale raw MIME path: repair tooling may fail to re-extract content but must not
  corrupt row identity
- stale content hash: backlog classification must treat downstream results as
  stale
- missing `remote_thread_id`: allowed only as an explicit compatibility case,
  not as the target norm

## Out Of Scope

- cross-provider canonical message deduplication
- attachment text extraction as part of the active message contract
- vector/embedding storage

## Evidence Inspectors

Message detail surfaces use `DataInspector` for current labels,
classification history, finance intelligence, moderation output, message row
metadata, attachments, and latest profile context. Inspectors keep raw JSON
available while preserving redaction rules for raw RFC822 bodies and secrets.
