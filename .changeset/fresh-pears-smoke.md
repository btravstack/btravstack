---
"@btravstack/di": patch
---

Fix `TS4020` in consumers that export a port. `export class OrderRepository extends
Port("OrderRepository")<Shape> {}` — the pattern the README teaches — could not emit
declarations: the emitter had no name for the heritage expression's type, so it expanded
down to `PortInstance`'s module-private `unique symbol` brands and reported "has or is
using private name 'ID'". `PortClass` and `ManyPortClass` are now exported as types, which
gives the emitter a name to stop at. The brand symbols themselves stay unexported, so port
identity remains nominal and a port instance remains unforgeable.
