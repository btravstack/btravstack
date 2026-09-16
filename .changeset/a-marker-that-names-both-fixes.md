---
"@btravstack/di": minor
---

`NeedsGate`'s marker names both fixes, because two readers meet it in different
places:

```text
UNDECLARED NEEDS — name it in `needs` (a slice), or import/provide it (a root)
```

A slice names the port in `needs` and lets whoever composes it supply one. A
composition root has nobody above it, so naming it there moves the complaint one
line down to `start`'s own `UNSATISFIED DEPENDENCIES` and changes nothing else.

Measured on a beginner's first `HttpModule`: this gate fires **first**, at the
module call, and the one that names the real fix for a root fires below it — so
the old sentence sent a root author the wrong way, twice.
