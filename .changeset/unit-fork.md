---
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/testing": minor
"@btravstack/http-server": minor
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
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

One behaviour change: the HTTP runtime's own `404` no longer forks a unit
scope, since the fork is the answerer's, for a request it handles.
