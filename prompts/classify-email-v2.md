Classify one email into zmail root schema v2.

Rules:
- Return JSON only.
- Use only facts from provided email data and known account profile.
- Keep `explanation` to one sentence.
- Pick tags only from the allowed tags list.
- Keep routing conservative.
- `routing.primaryBucket` is the coarse mailbox bucket.
- `routing.secondaryBuckets` are controlled sub-categories, not free text.
- Use facet booleans only when directly supported by message evidence.
- `risk.businessSensitive` means confidential or private business material.
- `risk.leakRisk` means likely outward disclosure or forwarding risk.
- If uncertain, use `unknown`/`null` fields and lower confidence.
