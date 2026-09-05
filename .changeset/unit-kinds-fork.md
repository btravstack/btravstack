---
"@btravstack/http-server": major
"@btravstack/amqp-worker": major
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
`UNSATISFIED DEPENDENCIES`. A scheme that binds no module of its own falls back
to `anonymous`, so binding `{ anonymous }` alone keeps forking on every leaf
exactly as it did before; nothing is forked only when neither binds one. The
seed lands whenever a scheme resolved, whichever module is forked.

The walk behind it is now `resolveScheme(requirements, authenticators,
headers)`, answering `{ scheme, identity }`, with `principalOf(requirements,
resolved)` the fold to what a handler is injected. `resolvePrincipal` is the
two composed and is unchanged for callers.

`HttpModule` now GATES the kinds a root binds, because that fallback makes a
typo silent: `unit: { usre: M }` would fork `anonymous` on every request and
report nothing. When the router comes from `api.units<…>()` the bindable keys
are the kinds it declared and each value must be the module that kind declared;
when it comes from a plain `defineHttp()` they are `anonymous` plus every
scheme the answerers serve, read off their own authenticator ports. An
undeclared kind is refused against `UNDECLARED UNIT KIND — …`. `http()` and
`httpServer()` take the router as a need rather than a value, so their `unit`
stays the wide record.

An AMQP delivery seeds the unit fork, and a piece injects from it through
`context.unit`.

`unit.message`'s module is now forked with the validated message seeded on
`AmqpMessage(contract)` — the one port the worker seeds — so a unit module
derives a tenant, or anything else it scopes by, from the delivery rather than
from an ambient record. A module naming that port in `needs` owes the
composition root nothing for it; everything else it needs still surfaces at
`start`.

`AmqpHandler(contract, key)` now takes `{ inject, unit?, sync }` rather than
di's whole arm set. `unit` names the ports the handler reads off
`context.unit`, and `sync` is the only arm that can carry their types: its
return is typed by the record the piece declared, where the port it lands on
stays the context-free handler shape. A piece with no services is
`{ inject: {}, sync: () => handler }`; `value` is gone.

`AmqpModule` gates `unit.message` against what the pieces declared. Binding a
module that does not export a port some piece injects is refused against
`UNIT DOES NOT PROVIDE — …`, naming the port — including the case where no
module is bound at all. `amqp()` takes its handlers as a need rather than a
value, so it has nothing to gate against and is unchanged.
