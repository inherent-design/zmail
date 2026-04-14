# Message Model V2

## Summary

This document defines the next message-storage refactor after the current
Gmail live-sync hardening pass.

Goals:

- separate user-facing message time from ingestion time
- make Gmail thread identity the canonical conversation identity
- improve forwarded-email and parse-failure body extraction without breaking the
  current UI, moderation, or classification paths

Non-goals:

- changing the active Gmail OAuth flow
- changing worker or watcher control flow
- changing the current live-sync window model
- introducing cross-provider canonical email deduplication

## Current V1 Runtime Semantics

The active runtime is a Gmail-only corpus mirror.

- each stored `messages` row currently corresponds to one Gmail
  `message_sources` row
- the current corpus does not implement cross-source canonical email
  deduplication
- V2 conversation work is about grouping stored messages into conversations, not
  deduplicating logical emails across providers

Today:

- `messages.received_at`
  - canonical user-facing message timestamp
- `messages.created_at`
  - current row creation time for the local mirror
- `message_sources.first_seen_at` / `last_seen_at`
  - source-observation timestamps
- `messages.thread_key`
  - heuristic thread identity from `In-Reply-To` or normalized subject
- `message_sources.remote_thread_id`
  - Gmail-native thread identity
- `messages.body_text_normalized`
  - best-available downstream text for UI, search, moderation, and
    classification
- `messages.snippet`
  - display-oriented excerpt derived from normalized body text

Parse errors are non-fatal ingestion fallbacks in V1.

When parsing fails, the runtime still persists:

- `received_at` via IMAP `internalDate` fallback
- remote Gmail ids and UID state
- raw RFC822 path and raw hash
- parsed-content hash

It currently degrades:

- subject, sender, and recipient structure
- normalized body text and snippet
- parse failure detail, which is not stored as a structured reason yet

## Current Identity And Freshness Semantics

The current runtime uses distinct identities and hashes for different purposes.

### Message identities

- `messages.id`
  - local primary key only
- `messages.message_id`
  - RFC822 `Message-ID`
  - descriptive/header identity
  - not the current dedupe key
  - not guaranteed unique by schema
- `message_sources.remote_message_id`
  - current Gmail corpus dedupe key per account
  - the identity used by `ingestMessage()` refresh detection
- `message_sources.remote_thread_id`
  - current Gmail-native conversation identity

### Hashes and freshness

- `message_sources.raw_sha256`
  - raw RFC822 byte hash
  - used by sync to decide whether an already-known source needs a re-parse and
    refresh
- `messages.content_sha256`
  - normalized parsed-content hash
  - used to determine whether moderation, classification results, and materialized
    labels are stale
- `classification_results.input_content_sha256`
  - records which parsed-content hash a classification run used
- `message_labels.content_sha256`
  - records which parsed-content hash the current active label corresponds to

Current behavior comes from:

- [`lib/sync.ts`](/Users/zer0cell/production/zmail/lib/sync.ts)
- [`lib/worker.ts`](/Users/zer0cell/production/zmail/lib/worker.ts)
- [`lib/classify.ts`](/Users/zer0cell/production/zmail/lib/classify.ts)
- [`lib/moderation.ts`](/Users/zer0cell/production/zmail/lib/moderation.ts)

## Current Gmail Corpus Invariants

The following are observed runtime invariants for the current Gmail-only corpus.
They are not universal future guarantees unless later enforced by schema or code.

- every current `messages` row has exactly one `message_sources` row
- no current rows have null `message_sources.remote_message_id`
- no current rows have null `message_sources.remote_thread_id`

Observed values from the live corpus on `2026-04-14`:

- `multi_source_messages = 0`
- `messages_without_remote_message = 0`
- `messages_without_remote_thread = 0`

Implications:

- conversation backfill for the existing corpus can be written as a complete join
  from `message_sources.remote_thread_id`
- `conversation_id = NULL` is only a future edge-case path for missing Gmail
  thread ids, not the expected state for the current corpus

## Current UI / Loader / Inference Surfaces

### Message List Surface

Current list surfaces use:

- `received_at`
- `sender_address`
- `subject`
- current label state:
  - `primary_bucket`
  - `nsfw`
  - `low_confidence`

The list is currently ordered by `received_at`.

### Message Detail Surface

Current detail surfaces use:

- `received_at`
- `sender_name`
- `sender_address`
- `to_json`
- `cc_json`
- `subject`
- `in_reply_to`
- `thread_key`
- `body_text_normalized`
- `snippet`
- `attachment_count`
- `has_html`
- `parse_status`
- `token_estimate`
- attachments
- moderation result
- classification history
- latest overseer profile

### Review Surface

Current low-confidence review surfaces use:

- `subject`
- `sender_address`
- `snippet`
- current classification result payload

### Classification And Moderation Inputs

Current moderation and classification flows use:

- `received_at`
- `body_text_normalized`
- attachment summaries
- `messages.content_sha256` freshness

During V2 migration, these inputs must remain stable until body re-extraction
and downstream validation are complete.

## Why Thread Key Drifts From Gmail Threads

`thread_key` is derived in [`lib/normalize.ts`](/Users/zer0cell/production/zmail/lib/normalize.ts):

- `In-Reply-To` takes precedence
- normalized subject root is the fallback

That makes it intentionally heuristic.

It can:

- fragment one Gmail thread into many local `thread_key` values
- collapse unrelated Gmail threads under one normalized subject

Observed evidence from the live corpus on `2026-04-14`:

- `4` Gmail thread ids currently fan out to multiple `thread_key` values
- `10` local `thread_key` values currently collapse multiple Gmail thread ids

`thread_key` should therefore be treated as fallback/debug metadata, not the
primary conversation identity.

## Target V2 Semantics

## Timestamps

Target meanings:

- `messages.received_at`
  - the message timestamp shown to users and used for message chronology
- `messages.ingested_at`
  - first time zmail persisted the local message row into the corpus mirror
- `messages.created_at`
  - transitional technical field kept for backward compatibility during migration
- `message_sources.first_seen_at`
  - first time a specific remote source was observed in sync
- `message_sources.last_seen_at`
  - most recent time a specific remote source was observed in sync

Rules:

- UI lists remain sorted by `messages.received_at`
- product/debug discussions should use `messages.ingested_at` for ingestion timing
- source-observation timestamps remain provenance fields, not primary UI
  timestamps

## Conversations

Target meanings:

- Gmail thread id is the canonical conversation identity, scoped per account
- `messages.thread_key` becomes fallback/debug metadata only

Target structure:

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  first_message_received_at TEXT,
  last_message_received_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, gmail_thread_id)
);
```

Target message link:

- `messages.conversation_id TEXT REFERENCES conversations(id)`

Rules:

- when `message_sources.remote_thread_id` exists, it is authoritative
- `messages.thread_key` remains populated for diagnostics, fallback grouping, and
  migration support
- if a message lacks a Gmail thread id in future data, fallback grouping can use
  `thread_key`, but that is explicitly secondary behavior

## Body Extraction

Target meanings:

- `messages.body_text_normalized`
  - best-available downstream classifier/search text
- `messages.body_text_primary`
  - the main human-authored message body excluding forwarded blocks when
    detectable
- `messages.body_text_forwarded`
  - extracted forwarded payload when present
- `messages.body_extraction_strategy`
  - enum-like string describing how the body was derived
- `messages.parse_error_reason`
  - stored failure detail for parser-edge cases

Suggested `body_extraction_strategy` values:

- `plain_text`
- `html_to_text`
- `forwarded_split`
- `quoted_tail_stripped`
- `parse_error`
- `fallback_empty`

Rules:

- `body_text_normalized` remains the field consumed by current classifiers during
  migration
- forwarded-message extraction should preserve useful forwarded content instead
  of collapsing to a footer-only body
- parse failures should preserve an explicit reason, not just an empty body

### Snippet Semantics

Current V1:

- `snippet` is derived from `body_text_normalized`

Target V2:

- derive `snippet` from `body_text_primary` when non-empty
- otherwise derive it from `body_text_forwarded` when present
- otherwise keep it empty

`snippet` remains a display/read-model field, not a canonical storage primitive
for inference.

### Hash Semantics And Reprocessing

- `message_sources.raw_sha256`
  - triggers refresh and re-parse when remote raw bytes change
- `messages.content_sha256`
  - invalidates moderation, classification, and labels when normalized content
    changes
- body re-extraction or backfill that changes `body_text_normalized` must
  recompute `messages.content_sha256`
- the existing stale-label logic in the worker remains the compatibility
  mechanism during migration

### Forwarded-Email Handling

V1 forwarded handling is destructive.

Current source strips content starting at `Begin forwarded message:` in
[`lib/normalize.ts`](/Users/zer0cell/production/zmail/lib/normalize.ts), because
forwarded markers are treated like quoted tails.

That is why the current corpus can retain footer-only bodies for forwarded mail.

V2 body extraction must:

- split forwarded payloads before quote-tail stripping
- preserve forwarded content in `body_text_forwarded`
- derive a useful primary snippet/body instead of keeping only footer residue

## Schema Changes

Planned additions:

- `messages.ingested_at TEXT`
- `messages.conversation_id TEXT REFERENCES conversations(id)`
- `messages.body_text_primary TEXT NOT NULL DEFAULT ''`
- `messages.body_text_forwarded TEXT NOT NULL DEFAULT ''`
- `messages.body_extraction_strategy TEXT NOT NULL DEFAULT 'plain_text'`
- `messages.parse_error_reason TEXT`
- new `conversations` table

Columns to keep:

- `messages.received_at`
- `messages.thread_key`
- `messages.body_text_normalized`
- `messages.snippet`
- `messages.created_at`
- `message_sources.remote_thread_id`

Columns to treat as transitional:

- `messages.created_at`
- `messages.thread_key`

## Migration And Backfill Plan

This is an application-assisted migration, not a pure SQL migration.

### Phase A: additive schema

1. add nullable/new columns to `messages`
2. create `conversations`
3. add supporting indexes:
   - `conversations (account_id, gmail_thread_id)` unique
   - `messages (conversation_id)`
   - `messages (ingested_at DESC)` if later needed for admin/reporting

### Phase B: metadata backfill

1. backfill `messages.ingested_at = messages.created_at`
2. create conversations from distinct `(account_id, remote_thread_id)` pairs
3. backfill `messages.conversation_id` by joining through
   `message_sources.remote_thread_id`

Fallback rule for messages with missing `remote_thread_id`:

- leave `conversation_id = NULL` initially
- do not synthesize a fake Gmail thread id in the migration
- later ingestion code may create fallback conversations only for new data if
  needed

### Phase C: body re-extraction backfill

This should be handled by an application-level maintenance job, not by SQL.

Re-extraction should prioritize `parse_status = 'error'` rows first, because they
currently preserve sync continuity but lose structured parse output.

For each message with an available `raw_rfc822_path`:

1. re-read the raw RFC822 file
2. re-parse with the improved extraction logic
3. populate:
   - `body_text_primary`
   - `body_text_forwarded`
   - `body_extraction_strategy`
   - `parse_error_reason`
   - refreshed `body_text_normalized`
   - refreshed `snippet`
   - refreshed `content_sha256`

If raw content is unavailable:

- preserve current `body_text_normalized`
- preserve current `snippet`
- set `body_extraction_strategy = 'fallback_empty'` or equivalent

### Phase D: read-path migration

Update loaders/UI/inference in this order:

1. loaders continue returning current read fields unchanged
2. detail/debug surfaces add:
   - `ingested_at`
   - `conversation_id`
   - `remote_thread_id`
   - `body_text_primary`
   - `body_text_forwarded`
   - `body_extraction_strategy`
   - `parse_error_reason`
3. classification and moderation continue using `body_text_normalized` initially
4. after validation, evaluate whether downstream inference should use
   `body_text_primary + body_text_forwarded`

### Phase E: deprecation

Keep these fields for backward compatibility even after migration:

- `messages.created_at`
- `messages.thread_key`

Do not drop them until all dependent code and exports are migrated.

## Compatibility Plan

### Message List Surface

- keep list ordering on `received_at`
- keep sender/subject/label fields stable during the additive migration

### Message Detail Surface

- the current detail page still needs `thread_key` during transition
- future conversation metadata can be additive rather than replacing
  `thread_key` immediately
- `body_text_normalized` must remain available until V2 read paths are proven

### Review Surface

- review flow depends on `snippet`
- V2 body extraction must continue producing a stable display snippet even when
  the underlying body model becomes richer

### Classification And Moderation Inputs

- moderation and classification continue consuming `body_text_normalized` until
  V2 re-extraction is complete
- `content_sha256` must continue driving stale-label detection and reprocessing

## Known Source Drift

The following are planned, not current runtime:

- `messages.ingested_at`
- `conversations`
- `messages.conversation_id`
- `body_text_primary`
- `body_text_forwarded`
- `body_extraction_strategy`
- `parse_error_reason`

Current source drift to keep explicit:

- source still has only `body_text_normalized` and `snippet`
- source still uses `thread_key` in the message detail UI
- source has no read path for `remote_thread_id` or conversation metadata
- source has no application job yet for body re-extraction

## Acceptance Criteria For The Eventual Implementation

### Timestamps

- every message has:
  - `received_at`
  - `ingested_at`
- message list ordering continues using `received_at`
- debug/admin views can distinguish message time from ingest time

### Conversations

- every message with a Gmail thread id resolves to a `conversation_id`
- repeated Gmail thread ids group into a single conversation per account
- `thread_key` remains available only as fallback/debug metadata

### Body extraction

- forwarded messages no longer collapse to footer-only text when recoverable
  forwarded content exists
- parse-error rows retain a reason and explicit extraction strategy
- `snippet` remains stable for review and message-detail surfaces
- `body_text_normalized` remains non-breaking for current inference paths

### Migration safety

- additive migration preserves current routes and loaders
- backfill can be resumed safely
- existing rows without raw RFC822 remain readable and classifiable under
  fallback rules

## Assumptions

- Gmail remains the only provider in scope
- Gmail thread id is the correct canonical conversation identity for this
  product
- the current live corpus is representative enough to justify the refactor
  direction
- the eventual implementation will be staged and additive rather than a
  destructive one-shot rewrite

## Evidence Snapshot (2026-04-14)

Observed from the live SQLite on `2026-04-14`:

- `messages = 337`
- `parse_status = 'error'` on `13` rows
- `null received_at = 0`
- `null or empty subject = 13`
- `null or empty sender_address = 13`
- average drift from `received_at` to current row `created_at` is `362.09`
  hours
- max drift is `703.94` hours
- min drift is `6.29` hours
- distinct `message_sources.remote_thread_id = 326`
- distinct `messages.thread_key = 310`
- `4` Gmail thread ids currently map to multiple local `thread_key` values
- `10` local `thread_key` values currently collapse multiple Gmail thread ids

Observed forwarded-email issue:

- the live DB currently has `2` `Fw:` messages
- both normalize to a `31` character footer-only body:
  `Sent from Yahoo Mail for iPhone`

Observed parse-error issue:

- all `13` parse-error rows currently persist empty normalized bodies
- parse-error rows also account for the current empty subject and empty sender
  rows

Reference queries:

```sql
select count(*) as messages,
  sum(case when received_at is null then 1 else 0 end) as null_received_at,
  sum(case when subject is null or trim(subject)='' then 1 else 0 end) as null_or_empty_subject,
  sum(case when sender_address is null or trim(sender_address)='' then 1 else 0 end) as null_or_empty_sender
from messages;
```

```sql
select round(avg((julianday(created_at)-julianday(received_at))*24),2) as avg_hours_to_ingest,
  round(max((julianday(created_at)-julianday(received_at))*24),2) as max_hours_to_ingest,
  round(min((julianday(created_at)-julianday(received_at))*24),2) as min_hours_to_ingest
from messages
where received_at is not null;
```

```sql
select count(*) as multi_source_messages
from (
  select message_id
  from message_sources
  group by message_id
  having count(*) > 1
);
```

```sql
select count(*) as messages_without_remote_message
from message_sources
where remote_message_id is null;
```

```sql
select count(*) as messages_without_remote_thread
from message_sources
where remote_thread_id is null;
```

```sql
select count(distinct remote_thread_id) as distinct_remote_threads,
  count(distinct thread_key) as distinct_thread_keys
from messages
join message_sources on message_sources.message_id = messages.id;
```

```sql
select count(*) as remote_thread_to_multiple_thread_keys
from (
  select remote_thread_id
  from messages
  join message_sources on message_sources.message_id = messages.id
  group by remote_thread_id
  having count(distinct thread_key) > 1
);
```

```sql
select count(*) as thread_key_to_multiple_remote_threads
from (
  select thread_key
  from messages
  join message_sources on message_sources.message_id = messages.id
  group by thread_key
  having count(distinct remote_thread_id) > 1
);
```
