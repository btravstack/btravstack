---
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/testing": minor
"@btravstack/http-server": minor
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
"@btravstack/observability": minor
---

**Breaking.** `StartOptions.unit` is removed. A runtime forks the unit scope
itself: a unit's work receives a `UnitHost` — `{ ctx, fork }` — and
`fork(module, seed)` builds `module` the runtime chose over the application
context plus a seed, torn down by the kernel when the unit settles, inside
the unit as before.

Each starter binds its own module instead, on its own options —
`http({ unit: { anonymous } })`, `amqp({ unit: { message } })`,
`temporal({ unit: { activity } })` — and forks it where it handles the
request, the delivery or the activity. There is no separate gate for a bound
module's own unmet needs: they join the starter's ordinary `Needs` channel,
exactly like an import's, and surface through `start`'s existing
`UNSATISFIED DEPENDENCIES` diagnostic.

`Module.forkScope` accepts a typed `seed` — entries seeded from outside the
module tree are subtracted from the gate the same way the parent's own
exports are — though no starter seeds anything yet; each forks with `[]`.
`testRuntime(name, { unit })` forks per submitted unit; `bootFixture` no
longer takes `unit`.

`UnitSpanModule` moves with them: it is no longer composed as `start`'s
`unit`, but bound on a starter's own option — `unit: { anonymous:
UnitSpanModule }` — and forked by the runtime around every unit it opens.

Behaviour change: both HTTP answerers now fork **exactly once dispatch has
cleared every guard**, so a request that never reaches a handler never opens
a unit scope — the runtime's own `404`, a request oRPC's schema refuses before
dispatch, one `principalMiddleware` refuses, and an htmx request refused by
auth or by body validation. For a consumer whose unit module provides a
request-scoped logger, those four now log nothing where they used to log a
request's worth of lines.
