---
"@btravstack/http": minor
---

Add `HttpController(name, fragment)([deps], { sync })` and a keyed
`HttpRouter(contract)(controllers)` form, so a large API can be split into
slices that each own a contract fragment and its implementation.

A controller is an ordinary di provider on a port the factory mints and hands
back on `provider.port`. The root composes them by contract key, and a missing
slice, an undeclared key, a controller under the wrong key and a fragment that
has drifted from the contract are all compile errors. The positional
`HttpRouter(contract)(deps, { sync })` form is unchanged and still right for a
small API.

Because a fragment is itself a valid contract, a slice can be served as its own
process without changing its controller.
