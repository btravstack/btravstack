---
"@btravstack/entity": minor
---

Entities, aggregates and `Entity.union` values carry `json`: the schema of what
`z.encode(output, x.toJSON())` writes, a plain `ZodObject` to pick a response
body from. `Entity.codec(wire, domain, transforms)` declares a field JSON cannot
hold — `z.union([z.codec(wire, domain, transforms), domain])`, codec first — so
`make`, `update` and nesting accept its own decoded value and `json` describes
its wire text.
