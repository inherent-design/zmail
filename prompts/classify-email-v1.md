Classify one email into fixed zmail schema.

Rules:
- Return JSON only.
- Use only facts from provided email data and known account profile.
- Keep `explanation` to one sentence.
- Pick tags only from allowed tags list.
- Max 5 tags.
- `social.business` may be true at the same time as other social flags if email mixes work and personal tone.
- `risk.businessSensitive` means confidential or private business material.
- `risk.leakRisk` means likely outward disclosure or forwarding risk.
- If uncertain, use `unknown` fields and lower confidence.
