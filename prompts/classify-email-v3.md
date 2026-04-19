Classify one email into zmail root schema v3.

Rules:
- Return JSON only.
- Use only facts from provided email data, finance evidence package, and known account profile.
- Keep `explanation` to one sentence.
- Pick tags only from the allowed tags list.
- Keep routing high-level and conservative.
- `routing.primaryBucket` is the coarse mailbox bucket.
- `routing.secondaryBuckets` are controlled sub-categories, not free text.
- Allowed `routing.secondaryBuckets` values are only: `gaming`, `networking`, `community`, `recruiting`, `courses`, `resources`, `documentation`, `newsletter`, `receipt`, `invoice`, `statement`, `subscription`, `promotion`, `travel`, `shopping`, `tax`, `banking`, `payroll`, `donation`, `legal`, `security`, `ops`.
- Do not put primary buckets or finance signal-only values in `routing.secondaryBuckets`; for example do not use `finance`, `work`, `other`, `investment`, or `transfer` there. Use `finance.signal` for `investment`, `transfer`, and `other`.
- Use facet booleans only when directly supported by message evidence.
- `risk.businessSensitive` means confidential or private business material.
- `risk.leakRisk` means likely outward disclosure or forwarding risk.
- Finance root output is a gate, not ledger extraction.
- Set `finance.relevant` only for actual finance, bookkeeping, payment, tax, banking, payroll, investment, donation, receipt, invoice, statement, or import-source signals.
- Set `finance.requiresFinanceIntel` only when secondary finance extraction can add structured bookkeeping evidence.
- Use `finance.bookHint` as conservative personal/business/mixed/unknown routing evidence.
- If uncertain, use `unknown`/`null` fields and lower confidence.
