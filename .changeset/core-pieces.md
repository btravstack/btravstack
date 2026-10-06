---
"@btravstack/core": minor
"@btravstack/amqp-worker": patch
"@btravstack/temporal-worker": patch
---

**New in `@btravstack/core`: `mintPiece`, `composeByPrefix` and the `Refuse` type** — the runtime halves of a worker's piece factory and composing provider, which `AmqpHandler` / `AmqpHandlers` and `TemporalWorkflowActivities` / `TemporalActivities` each carried a copy of. A minted handler or activities piece no longer carries a runtime `unit` property: nothing read it, since the record travels with the piece's own wrapper. The `UNCOVERED …` refusals are unchanged.
