---
"@btravstack/observability": patch
---

`logLevel`'s parse validates with `ensure` and a type guard rather than a
`flatMap` returning the value it was handed. The narrowing is now proved by the
predicate instead of asserted twice with `as Level`.
