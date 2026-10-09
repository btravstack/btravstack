---
"@btravstack/orpc-server": minor
"@btravstack/htmx-server": minor
---

`HttpModule` provides the pieces its router and fragments compose. A root that
keeps its controllers itself lists each once, in `api.OrpcRouter(contract)([…])`,
instead of again in `provides`; a slice that provides and exports its own piece
keeps working, since the same provider seen twice is one provider. The composed
providers carry their pieces on `pieces`, for a root built on `http()`.
