# Message Model V2

## Summary

This document defines the next message-storage refactor after the current live-sync hardening pass.

Goals:

- separate user-facing message time from ingestion time
- make Gmail thread identity the canonical conversation identity
- improve forwarded-email and parse-failure body extraction without breaking the current UI or classifiers

Non-goals:

- changing the active Gmail OAuth flow
- changing watcher/job semantics
- changing the current live-sync window model

## Current Observed Data

Observed from the live SQLite on **2026-04-14**:

- `messages = 337`
- `parse_status = 'error'` on `13` rows
- `null received_at = 0`
- `null or empty subject = 13`
- `null or empty sender_address = 13`
- average drift from `received_at` to current row `created_at` is `362.09` hours
- max drift is `703.94` hours
- min drift is `6.29` hours
- distinct `message_sources.remote_thread_id = 326`
- distinct `messages.thread_key = 310`
- `4` Gmail thread ids currently map to multiple local `thread_key` values
- `10` local `thread_key` values currently collapse multiple Gmail thread ids

Observed forwarded-email issue:

- the live DB currently has `2` `Fw:` messages
- both normalize to a `31` character footer-only body: `Sent from Yahoo Mail for iPhone`
- the raw RFC822 sample for `Fw: 2026 Swim Lessons` contains:
  - a Yahoo footer
  - `Begin forwarded message:`
  - a large forwarded text/plain block after that marker

Observed parse-error issue:

- all `13` parse-error rows currently persist empty normalized bodies
- parse-error rows also account for the current empty subject / empty sender rows

Implication:

- `messages.created_at` is not an acceptable substitute for ingestion semantics in product/UI discussions
- `messages.thread_key` is not reliable as the primary conversation identity
- the current normalization path is insufficient for forwarded and parser-edge-case messages

## Active V1 Semantics

Today:

- `messages.received_at`
  - canonical user-facing message timestamp
- `messages.created_at`
  - row creation time for the current mirror
- `message_sources.first_seen_at` / `last_seen_at`
  - sync-observation timestamps
- `messages.thread_key`
  - heuristic thread identity from `In-Reply-To` or normalized subject
- `message_sources.remote_thread_id`
  - Gmail-native thread identity
- `messages.body_text_normalized`
  - best-available current downstream text for UI, search, and classification

## Target V2 Semantics

### Timestamps

Target meanings:

- `messages.received_at`
  - the message timestamp shown to users and used for message chronology
- `messages.ingested_at`
  - first time zmail persisted the message row into the corpus mirror
- `messages.created_at`
  - transitional technical field kept for backward compatibility during migration
- `message_sources.first_seen_at`
  - first time a specific remote source was observed in sync
- `message_sources.last_seen_at`
  - most recent time a specific remote source was observed in sync

Rules:

- UI lists remain sorted by `messages.received_at`
- product discussions and reporting should use `messages.ingested_at` for ingestion timing
- `message_sources.first_seen_at` / `last_seen_at` remain source-provenance fields, not primary UI timestamps

### Conversations

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

- add `messages.conversation_id TEXT REFERENCES conversations(id)`

Rules:

- when `message_sources.remote_thread_id` exists, it is authoritative
- `messages.thread_key` remains populated for diagnostics, fallback grouping, and migration support
- if a message somehow lacks a Gmail thread id, fallback grouping can still use `thread_key`, but that is explicitly a fallback path and not the primary identity model

### Body Extraction

Target meanings:

- `messages.body_text_normalized`
  - best-available downstream classifier/search text
- `messages.body_text_primary`
  - the main human-authored message body excluding forwarded blocks when detectable
- `messages.body_text_forwarded`
  - extracted forwarded payload when present
- `messages.body_extraction_strategy`
  - enum-like string describing how the body was derived
- `messages.parse_error_reason`
  - structured or semi-structured parse failure detail for parser-edge cases

Suggested `body_extraction_strategy` values:

- `plain_text`
- `html_to_text`
- `forwarded_split`
- `quoted_tail_stripped`
- `parse_error`
- `fallback_empty`

Rules:

- `body_text_normalized` remains the field consumed by current classifiers during migration
- forwarded-message extraction should preserve useful forwarded content instead of collapsing to a footer-only body
- parse failures should preserve an explicit reason, not just an empty body

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
- `messages.created_at`
- `message_sources.remote_thread_id`

Columns to treat as transitional:

- `messages.created_at`
- `messages.thread_key`

## Migration and Backfill Plan

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
3. backfill `messages.conversation_id` by joining through `message_sources.remote_thread_id`

Fallback rule for messages with missing `remote_thread_id`:

- leave `conversation_id = NULL` initially
- do not synthesize a fake Gmail thread id in the migration
- later ingestion code may create fallback conversations only for new data if needed

### Phase C: body re-extraction backfill

This should be handled by an application-level maintenance job, not by SQL.

For each message with an available `raw_rfc822_path`:

1. re-read the raw RFC822 file
2. re-parse with the improved extraction logic
3. populate:
   - `body_text_primary`
   - `body_text_forwarded`
   - `body_extraction_strategy`
   - `parse_error_reason`
   - refreshed `body_text_normalized`

If raw content is unavailable:

- preserve current `body_text_normalized`
- set `body_extraction_strategy = 'fallback_empty'` or equivalent

### Phase D: read-path migration

Update loaders/UI/inference in this order:

1. loaders continue returning `received_at`
2. detail/debug surfaces add:
   - `ingested_at`
   - `conversation_id`
   - `remote_thread_id`
   - `body_text_primary`
   - `body_text_forwarded`
   - `body_extraction_strategy`
   - `parse_error_reason`
3. classification/moderation continue using `body_text_normalized` initially
4. after validation, evaluate whether classifiers should switch to `body_text_primary + body_text_forwarded` composition

### Phase E: deprecation

Keep these fields for backward compatibility even after migration:

- `messages.created_at`
- `messages.thread_key`

Do not drop them until all dependent code and exports are migrated.

## Compatibility Plan

### UI

Current UI surfaces that depend on existing fields:

- message list uses `messages.received_at`
- message detail shows:
  - `received_at`
  - `thread_key`
  - `parse_status`
  - `body_text_normalized`

Compatibility defaults:

- message list keeps using `received_at`
- detail page can continue showing `thread_key` while adding Gmail conversation metadata later
- `body_text_normalized` remains available during the migration

### Server loaders

Current loaders can remain stable during the additive migration.

Future additive loader fields:

- `ingested_at`
- `conversation_id`
- `remote_thread_id`
- `body_text_primary`
- `body_text_forwarded`
- `body_extraction_strategy`
- `parse_error_reason`

### Inference

Current moderation/classification inputs use `body_text_normalized`.

Default migration strategy:

- keep `body_text_normalized` as the inference input until the re-extraction backfill is complete
- only then evaluate whether a structured primary/forwarded composition improves classification quality

## Research Queries

These are the baseline queries for future design reviews and validation:

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

```sql
select parse_status,
  count(*) as n,
  round(avg(length(body_text_normalized)),1) as avg_body_len,
  sum(case when trim(body_text_normalized)='' then 1 else 0 end) as empty_bodies
from messages
group by parse_status;
```

```sql
select messages.id, subject, sender_address, received_at, raw_rfc822_path
from messages
join message_sources on message_sources.message_id = messages.id
where lower(subject) like 'fwd:%' or lower(subject) like 'fw:%'
order by received_at desc;
```

## Acceptance Criteria For The Eventual Implementation

### Timestamps

- every message has:
  - `received_at`
  - `ingested_at`
- message list ordering continues using `received_at`
- admin/debug views can distinguish message time from ingest time

### Conversations

- every message with a Gmail thread id resolves to a `conversation_id`
- repeated Gmail thread ids group into a single conversation per account
- `thread_key` remains visible only as fallback/debug metadata

### Body extraction

- forwarded messages no longer collapse to footer-only text when recoverable forwarded content exists
- parse-error rows retain a reason and explicit extraction strategy
- `body_text_normalized` remains non-breaking for existing inference paths

### Migration safety

- additive migration preserves current routes and loaders
- backfill can be resumed safely
- existing rows without raw RFC822 remain readable and classifiable under fallback rules

## Assumptions

- Gmail remains the only provider in scope.
- Gmail thread id is the correct canonical conversation identity for this product.
- The current live corpus is representative enough to justify the refactor direction.
- The eventual implementation will be staged and additive rather than a destructive one-shot rewrite.
