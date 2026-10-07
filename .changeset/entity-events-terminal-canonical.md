---
"@btravstack/entity": minor
---

**Aggregate events: input-typed commands, terminal events and a canonical `toJSON()`.**

- `emit` and `start` take each event's `z.input`, since both already parse it: an event can carry a nested part through the part's own `input` schema and still be built from plain values. The decision's `events` stay the union's output.
- `Entity.aggregate`'s new `ends: [...]` option declares the terminal events. `Decision.isTerminal` is `true` once one is decided, so a repository can stop loading the aggregate (keeping its version as a tombstone) without matching a `type` string. `emit` with an event after a terminal one does not compile, emitting on an ended state is a defect, and `replay` refuses a stream that continues past a terminal event with an `InvalidEntity` at that index.
- `toJSON()` omits an unset optional field at every depth (top level, plain objects, nested entities, entities in arrays) instead of carrying it as `undefined`, whatever built the state, so diffing two projections is supported. **Observable change:** `Object.keys(toJSON())` and `Object.keys(entity)` no longer list unset optional fields; the field still reads `undefined` and still cannot be assigned.
