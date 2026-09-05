---
"@btravstack/http-server": major
---

An HTTP request forks the unit module of the KIND that authenticated it, seeded
with its principal.

`unit` on `http()`, `httpServer()` and `HttpModule` is now a record of kind →
module rather than `{ anonymous?: Module }`. The kind is `anonymous` for a leaf
that asked for no credential, else the scheme that resolved one — so
`unit: { anonymous: RequestModule }` keeps its meaning and a graph binding only
that needs no change.

A scheme's fork is seeded with `[[auth.principals[scheme], identity]]`, which
is what discharges a unit module's `needs: [auth.principals.user]` — the
principal is subtracted from what the composition root owes, while everything
else the module needs still surfaces at `start`'s
`UNSATISFIED DEPENDENCIES`. A kind with **no** bound module forks nothing, and
does not fall back to `anonymous`.

The walk behind it is now `resolveScheme(requirements, authenticators,
headers)`, answering `{ scheme, identity }`, with `principalOf(requirements,
resolved)` the fold to what a handler is injected. `resolvePrincipal` is the
two composed and is unchanged for callers.
