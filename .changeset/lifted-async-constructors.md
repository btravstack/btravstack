---
"@btravstack/di": patch
"@btravstack/observability": patch
---

Internal spelling only, no behaviour change: `Ok(v).toAsync()` and
`Err(e).toAsync()` are now the pre-lifted `OkAsync(v)` / `ErrAsync(e)` the
repository's own convention asks for, and a nullable lookup is `fromNullable`
rather than a hand-written ternary.
