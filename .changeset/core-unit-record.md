---
"@btravstack/core": minor
"@btravstack/amqp-worker": patch
"@btravstack/temporal-worker": patch
---

**New in `@btravstack/core`: `dispatchUnit`, `withUnitRecord`, and the `AnyUnitModule`, `UnitNeedsOf`, `UnitExportsOf`, `UnitRecordOf` and `UnitGate` types.** The AMQP and Temporal workers each carried the same middleware body and the same `context.unit` wrapper, and every package taking a `unit` option declared `AnyUnitModule` again. They now share one copy. Nothing changes for an application: the workers behave exactly as before, and the gates report the same sentences.
