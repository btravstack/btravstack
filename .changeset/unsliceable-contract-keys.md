---
"@btravstack/http-server": patch
---

Refuse a contract key containing a literal dot, at compile time, instead of
serving it as a 404.

A piece's path is joined and split on `.`, so `nest` could not tell a path
**separator** from a dot **inside** one contract key. A contract keyed
`{ "a.b": oc }` therefore minted a piece at `"a.b"`, passed coverage, rebuilt
as `{ a: { b: fn } }`, and was then discarded by `routerOf`'s stray-key drop —
a fully green compile and a route that 404s, which is the failure class this
stack exists to delete rather than document.

Both ends are closed now. `ControllerKeyOf` drops dotted keys at **every**
level, so such a piece is never mintable; and `HttpRouter(contract)([...])`
refuses a contract whose **top** level carries one against
`"UNSLICEABLE CONTRACT KEY — …"`. That marker is reported ahead of
`"UNCOVERED CONTROLLERS — …"` deliberately: _no piece can name this_ is a
different fact from _no piece did_, and only the first one tells you the array
form is the wrong tool. The sentence points at the `(deps, arm)` form, which
splits nothing and serves such a contract correctly — the escape hatch is
real and stays open.

Only the **top** level is fatal. A piece minted at a dotted key's parent hands
its implementation record to `routerOf` whole, and that walk splits paths,
never the keys underneath them — so `{ v1: { "a.b": oc } }` still composes
from a piece at `"v1"`, and the gate does not over-reach onto it.
