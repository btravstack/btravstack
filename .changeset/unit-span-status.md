---
"@btravstack/core": minor
"@btravstack/observability": patch
---

**New in `@btravstack/core`: `unitOutcome()` and the `UnitOutcome` type** — how the current unit's work settled (`"ok"`, or `"error"` for an `Err`, a `Defect` or a throw), readable from the unit's own teardown, which is handed only its service. `UnitRecord` is unchanged.

`@btravstack/observability`'s `UnitSpanModule` uses it: a unit the kernel aborted now ends its span with an error status and the message `aborted`, and a unit whose work failed ends it with an error status. Both used to end unmarked.
