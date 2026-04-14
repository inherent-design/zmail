Build stable account profile for email classification.

Rules:
- Return JSON only.
- Prefer stable recurring signals over one-off guesses.
- Keep `promptPreamble` concise and classification-focused.
- `promotedTags` should be conservative and reusable.
- Do not invent sensitive facts without evidence in aggregate inputs.
