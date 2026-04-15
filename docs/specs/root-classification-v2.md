# Root Classification V2

## Summary

`message-label.v2` is the active root classifier contract.

It remains the mailbox-wide review and routing layer, but broadens the category
 surface so new domains can be introduced without turning every new semantic
 need into a new top-level classifier rewrite.

## Contract

- `schemaVersion = "message-label.v2"`
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

### `routing`

- `primaryBucket`
  - `finance`
  - `work`
  - `relationships`
  - `knowledge`
  - `assets`
  - `entertainment`
  - `system`
  - `other`
- `secondaryBuckets`
  - controlled enum including:
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
- `tags`

## Role

The root classifier is still responsible for:

- mailbox-wide bucketing
- low-confidence review queue
- main `/messages`, `/review`, and default detail semantics
- overseer context generation
- secondary-classifier routing

## Compatibility

- persisted legacy `message-label.v1` rows are normalized into v2 semantics on
  read paths where needed
- new writes persist `message-label.v2`
- backlog freshness treats non-v2 root labels as stale

