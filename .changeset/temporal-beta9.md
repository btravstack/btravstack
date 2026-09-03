---
"@btravstack/temporal-worker": minor
---

The three `@temporal-contract/*` peer floors move to `^8.0.0-beta.9`.

That release renames two things outright, with no alias:
`propagateActivityFailure` → `propagateFailure`, and a workflow's
`idempotency` → `startPolicy`. This package's own surface is untouched — it
re-exports neither — but its README's composition sample declares a workflow,
so on beta.7 or beta.8 that sample no longer compiles. A floor that admits a
version the documentation contradicts is the drift this repo gates everything
else against, so it moves with the sample.
