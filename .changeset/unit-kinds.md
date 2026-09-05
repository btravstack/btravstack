---
"@btravstack/http-server": minor
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
---

**Breaking.** A unit is opened under a KIND, and the kind's own module is what
the runtime forks — seeded with what the unit was opened for, and read back by
a leaf through `context.unit`.

**`defineHttp` is two steps now.** `defineHttp({ authenticators })` mints one
principal port per declared scheme, on `auth.principals`, and a second call —
`auth.units<{ anonymous: typeof A; user: typeof U }>()` — retypes the **same
object** by the module each kind binds. The kinds arrive on a second call for a
reason a single call cannot have: a unit module names
`auth.principals.<scheme>`, so its type depends on `typeof auth`; if `auth` in
turn depended on the modules the kinds bind, the two would be mutually
recursive and TypeScript reports `TS7022`. Nothing is rebuilt, and an
application that never calls `units<…>()` is unchanged. `principalPort`,
`Principals`, `Kinds` and `UnitsOf` are exported.

**`unit` is a record of kind → module** on `http()`, `httpServer()` and
`HttpModule` — `anonymous` for a leaf that asked for no credential, else the
scheme that resolved one. A scheme that binds no module **falls back to
`anonymous`**, so `unit: { anonymous: RequestModule }` keeps its meaning and a
graph binding only that needs no change. A request forks nothing only when the
scheme and `anonymous` both bind no module. The fallback is deliberate: an unbound kind forking nothing would
make every existing application silently lose its request scope on precisely
its authenticated procedures.

**`context.unit`, on all three transports.** Every piece — and every
whole-record composer beside it: `OrpcController`, `OrpcRouter`,
`AmqpHandler`, `AmqpHandlers`, `HtmxGet`, `HtmxPost`,
`TemporalWorkflowActivities`, `TemporalActivities` — takes an optional
`unit: { name: Port }` beside `inject`, declared once, and every leaf reads it
as `context.unit.name`. On HTTP the record is filtered **per leaf** by the kind
that leaf's own requirements select, with the `anonymous` fallback applied per
scheme: a name the kind's module does not export is not a property, so reading
it is TypeScript's own "property does not exist", and a leaf accepting several
schemes keeps only what every one of their modules exports. Entries are lazy
getters over the fork. A piece that declares no record compiles unchanged, and
`context.unit` is `{}`.

**Two seed ports.** `AmqpMessage(contract)` carries the validated delivery and
`ActivityInput(contract)` the validated activity input; HTTP seeds
`auth.principals[scheme]` with the identity that scheme resolved, whichever
module ends up forked. A unit module naming a seeded port owes the composition
root nothing for it — it is subtracted from what the starter reports — while
everything else it needs still surfaces at `start`'s
`UNSATISFIED DEPENDENCIES`.

**Three gates.** `HttpModule` refuses a kind no request can open under, against
`UNDECLARED UNIT KIND — …`: the bindable set is the kinds `units<…>()` declared
when the router carries them, else `anonymous` plus every scheme the answerers
serve, read off their own authenticator ports. `AmqpModule` and
`TemporalModule` refuse a bound module that does not export a port some piece —
or the whole-record arm — injects, against `UNIT DOES NOT PROVIDE — …`, naming
the port, including the case where no module is bound at all.

**Signature changes beyond the added option.** `FragmentAnswer.handle` takes the
handler's whole `context` object rather than the bare principal: it was
`handle(principal, params, input)` and is now
`handle({ principal, unit }, params, input)`. `AmqpHandler(contract, key)`,
`TemporalWorkflowActivities(contract, key)` and the record arms of
`AmqpHandlers(contract)` and `TemporalActivities(contract)` take
`{ inject, unit?, sync }` rather than di's whole arm set — `value` **could**
have carried the same record, since the options are each package's own and the
declared record is what types it either way, and it was dropped so one arm reads
the same as `@btravstack/http-server`'s `OrpcController` and `OrpcRouter` on all
three transports.

**`http()`, `httpServer()`, `amqp()` and `temporal()` stay un-gated**, and
structurally so: each takes its router, handlers or activities as a **need**,
never as a value, so there is nothing to check a bound `unit` against. Their
option keeps the wide record. A hand-rolled composition that wants the gate
composes through `HttpModule`, `AmqpModule` or `TemporalModule`.
