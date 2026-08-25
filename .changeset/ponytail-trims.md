---
"@btravstack/contract": minor
"@btravstack/di": minor
"@btravstack/config": minor
"@btravstack/core": minor
"@btravstack/testing": minor
"@btravstack/observability": minor
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

The `Unmet` type is gone from `@btravstack/di`

Its documented purpose — a shaped module re-declaring the gates with it — was
impossible to serve: declaration emit keeps the alias unreduced, and the
unreduced form names imported modules' internal ports (TS2883 on the first
consumer that exports a composition root), which is why every in-repo sugar
already inlined the computation instead. Inline it; `NeedsGate` is unchanged
and still exported.

Internal trims alongside, none of them surface: `@btravstack/http-server` no longer
memoises scheme ports (di resolves by id, so a fresh class per call is the same
lookup — measured), and `HasMark`, `authenticatorPort` and `Http.authenticators`
now carry TSDoc naming the external consumer each exists for, so their lack of
an in-repo caller stops reading as dead surface.
