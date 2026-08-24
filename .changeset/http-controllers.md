---
"@btravstack/http": minor
---

Add `HttpController(contract, key)({ name: Dep }, { sync })` — or `({ sync })`
with no deps — and an array-composing `HttpRouter(contract)([piece, …])` form,
so a large API can be split into slices that each own a contract fragment and
its implementation. Both come off `defineHttp` — see the _named security
schemes_ entry.

A controller is an ordinary di provider on a port the factory mints from the
contract key and hands back on `provider.port`. The root composes pieces by
array: a fragment no piece covers is refused against the composing call's
`"UNCOVERED CONTROLLERS — the contract declares a fragment this array does not
cover"` marker, and a key the contract does not declare is refused at the
mint itself — there is nothing there to type it by. The
`HttpRouter(contract)(deps, { sync })` form is unchanged and still right for a
small API.

Because a fragment is itself a valid contract, a slice can be served as its own
process without changing its controller.
