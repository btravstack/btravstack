---
"@btravstack/http": minor
---

Add `HttpController(contract, key)({ name: Dep }, { sync })` — or `({ sync })`
with no deps — and an array-composing `HttpRouter(contract)([piece, …])` form,
so a large API can be split into slices that each own a node of the contract
tree — named by a dotted path, `"orders"` or `"v1.orders"` — and its
implementation. Both come off `defineHttp` — see the _named security
schemes_ entry.

A controller is an ordinary di provider on a port the factory mints from the
path and hands back on `provider.port`. The root composes pieces by
array, and the paths must partition the contract's procedures: an uncovered
procedure is refused against the composing call's
`"UNCOVERED CONTROLLERS — the contract declares a procedure this array does
not cover"` marker, a piece nested inside another piece's fragment against
`"OVERLAPPING CONTROLLERS — a piece sits inside another piece's fragment"`,
and a path the contract does not declare is refused at the
mint itself — there is nothing there to type it by. A mark on an ancestor
reaches a piece minted from below it, so its handlers type
`context.principal` exactly as the served router injects one. The
`HttpRouter(contract)(deps, { sync })` form is unchanged and still right for a
small API.

Because a fragment is itself a valid contract, a slice can be served as its own
process without changing its controller.
