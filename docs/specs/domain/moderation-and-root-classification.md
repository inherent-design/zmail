# Moderation and Root Classification

## Purpose

This document defines the active moderation and root-labeling contract for
zmail vNext.

## Scope

Covered here:

- moderation ontology
- moderation freshness
- `message-label.v3`
- `nsfw` derivation boundary
- review semantics

## Moderation Contract

Active moderation schema:

- `schemaVersion = "message-moderation.v1"`
- `nsfw`
- category booleans:
  - `explicitSexual`
  - `suggestiveSexual`
  - `nudity`
  - `sexualMinors`
  - `adultCommercial`
- score map
- explanation

## Moderation Ontology

`adultCommercial` means sexual adult commerce only:

- pornography
- cam
- escort
- explicit adult subscription
- sexual services
- clearly erotic paywalled content

It does not mean:

- mainstream acting/modeling/casting
- talent marketplaces
- brand/commercial shoots
- creator or networking platforms
- generic subscriptions or upsells

## Moderation Freshness

Moderation freshness depends on prompt version.

Rules:

- moderation rows store the prompt version inside the raw response payload
- a moderation row is current only when its stored prompt version matches the
  active moderation prompt version
- missing or invalid prompt-version metadata makes the row stale
- stale moderation is recomputed in place

## NSFW Boundary

`nsfw` in the root label comes from moderation, not from the root classifier
inventing its own sexual-content policy.

The boundary rules are:

- moderation decides category booleans and category scores
- the runtime derives `nsfw_flag` from moderation output
- root classification persists the moderation-derived NSFW state

## Root Label Contract

Active root schema:

- `schemaVersion = "message-label.v3"`
- `nsfw`
- `finance`
- `people`
- `commerce`
- `knowledge`
- `assets`
- `entertainment`
- `risk`
- `routing`
- `confidence`
- `explanation`

Root labels remain a high-level mailbox contract. They route messages, decide
whether finance secondary work is required, and drive the main review queue.
They do not contain ledger-ready transactions.

### Finance Gate

`finance` in `message-label.v3` is a gate, not the final finance classifier.

Fields:

- `relevant`
  - whether the message has finance relevance at all
- `signal`
  - `none`
  - `receipt`
  - `invoice`
  - `statement`
  - `banking`
  - `tax`
  - `payroll`
  - `investment`
  - `donation`
  - `subscription`
  - `transfer`
  - `promotion`
  - `other`
- `operational`
  - whether the message is likely useful for bookkeeping, tax evidence, account
    reconciliation, or export
- `bookHint`
  - `personal`
  - `business`
  - `mixed`
  - `unknown`
- `requiresFinanceIntel`
  - whether `finance_intel` must run
- `confidence`
  - finance gate confidence, `0..1`
- `evidence`
  - short evidence phrase grounded in message-visible facts

Rules:

- financial promotions and generic product notices may be relevant but usually
  are not operational
- only operational finance messages require `finance-intel.v3`
- root-label normalization forces `operational = true` and
  `requiresFinanceIntel = true` when `relevant = true` and `signal` is one of
  `receipt`, `invoice`, `statement`, `banking`, `tax`, `payroll`,
  `investment`, `donation`, or `transfer`
- `none`, `promotion`, `other`, and `subscription` are not force-gated by
  normalization; subscription notices can be future reminders without
  transaction evidence
- `bookHint` is a routing hint; final personal/business/mixed export handling
  belongs to `finance-intel.v3` and ledger staging

### Routing

Primary buckets:

- `finance`
- `work`
- `relationships`
- `knowledge`
- `assets`
- `entertainment`
- `system`
- `other`

Secondary buckets include:

- `gaming`
- `networking`
- `community`
- `recruiting`
- `courses`
- `resources`
- `documentation`
- `newsletter`
- `receipt`
- `invoice`
- `statement`
- `subscription`
- `promotion`
- `travel`
- `shopping`
- `tax`
- `banking`
- `payroll`
- `donation`
- `legal`
- `security`
- `ops`

## Freshness Rules

Root backlog considers a message stale when any of the following is true:

- moderation row missing
- moderation prompt version stale
- current root label missing
- current root label schema is not `message-label.v3`
- current root label content hash differs from `messages.content_sha256`
- model root label prompt version differs from active classifier prompt version
- model root label prompt SHA-256 differs from active prompt file contents

Manual root labels are authoritative. Prompt-only version or hash changes do not
stale a current `message_labels.source = "manual"` head, but content-hash and
schema mismatches still stale the message.

## Review Semantics

Low-confidence root labels create or update open reviews.

Rules:

- low-confidence reclassification updates the existing open review to point at
  the newest classification result
- high-confidence reclassification auto-resolves an open review when the model
  no longer needs operator review
- manual overrides change the current root label head without deleting history
- resolved accept and override reviews become bounded prompt examples for future
  root classifications from the same sender first, then the same sender domain
- first overseer profile bootstrap queues when an account has at least 25
  labels by default; existing profiles rebuild after 1000 additional labels by
  default

The review queue is rooted in the root classifier, not in secondary finance
candidate adjudication.

## Compatibility

- persisted legacy `message-label.v1` and `message-label.v2` rows may be read
  for archive or drift reporting only
- clean-breaking migration archives old root heads before v3 reclassification
- all new model writes must persist `message-label.v3`
- v1 and v2 current heads are stale after the finance model rewrite
- read paths that need a current label must not normalize v1/v2 into v3 after
  the migration has run

## Failure Modes

- invalid moderation response: fail closed and keep the message eligible for
  backlog reprocessing
- stale moderation with current root label: treat as stale root work
- parse-error messages: root label may exist, but finance secondary work that
  requires parsed text may block

## Out Of Scope

- human moderation tooling
- sender/domain-specific allowlists for NSFW
- replacing `message-label.v3` with secondary classifier output
