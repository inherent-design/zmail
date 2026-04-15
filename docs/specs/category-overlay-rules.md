# Category Overlay Rules

## Summary

zmail adds a deterministic category overlay on top of AI classification.

The root model and finance secondary model provide semantic inputs. Taxonomy and
 rule files then project stable operator-facing categories without rewriting
 classification history.

## Storage

- `classification_rule_sets`
- `classification_rules`
- `message_category_assignments`
- `message_category_assignment_heads`

## Operator files

- `data/operator/classification/root-taxonomy.yaml`
- `data/operator/classification/finance-taxonomy.yaml`
- `data/operator/classification/rules.yaml`

## Inputs

- root `message-label.v2`
- sender/domain
- account label and email
- attachment metadata
- `finance_intel` current result
- registry matches

## Outputs

- projected primary category
- projected secondary category
- projected finance primary category
- projected finance secondary category
- assignment source
  - `root_model`
  - `overlay_rule`
  - `finance_secondary`
  - `pdf_import`

## Reclassification semantics

- taxonomy or rule file changes immediately rebuild deterministic assignments
- prompt/schema changes to the root model queue root backlog reclassification
- finance taxonomy changes immediately affect finance assignment projection and
  rollups, even before any targeted finance AI backfill

