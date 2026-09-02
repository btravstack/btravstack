---
"@btravstack/core": minor
---

`UnitMeta.deadline` and `UnitRecord.deadline` are deleted — zero producers, zero
consumers, removed while breaking is free.

No shipped runtime stamped it (http mints `{ kind, id, traceId? }`; amqp and
temporal likewise) and no adapter read it: `createLogger` and `UnitSpanModule`
read `unitId`, `traceId` and `tenantId`, never this. Its sibling `tenantId`
carries the same "a hand-rolled runtime may stamp it" defence and has two
shipped readers; `deadline` had none.

The drain deadline already reaches every unit as `signal` — the field the spec
calls load-bearing, and the one both the work callback and the ambient record
carry. A hand-rolled runtime that wants a numeric deadline owns both ends and
can carry it itself.

Closes #208.
