---
"@btravstack/http-server": minor
---

Add `HttpController(contract, path)({ name: Dep }, { sync })` and a composing
`HttpRouter(contract)([piece, …])` form, so a large API can be split into
slices that each own one node of the contract tree — a fragment, a nested
fragment, or a bare procedure — and its implementation. Both come off
`defineHttp` — see the _named security schemes_ entry.

A controller is an ordinary di provider on a port minted straight from the
contract path it serves, with no name to give: the path **is** the port's
name. The root composes an array of them, exact over the contract's
procedures — a missing piece, a path the contract does not declare (refused
at the piece's own mint, not at the router), a piece under the wrong path
(impossible by construction, since the path rides its own port id), and two
pieces whose paths nest one inside the other are all compile errors. A
contract marked at any ancestor of a piece's path types that piece's
`context.principal`, exactly as `routerOf`'s runtime walk protects it. The
`HttpRouter(contract)(deps, { sync })` form is unchanged and still right for
a small API.

Because a fragment is itself a valid contract, a slice can be served as its
own process without changing its piece.
