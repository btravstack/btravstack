---
"@btravstack/testing": minor
"@btravstack/core": minor
"@btravstack/http-server": minor
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
---

**`overridden` reaches inside a unit module, so a composition root stays a constant.** `overridden(root, providers, { unit: { user: [Provider(OrderRepository)(…)] } })` substitutes a provider inside the module a root binds for a unit kind — `user` or any HTTP scheme, `message` on AMQP, `activity` on Temporal — where a root-level override could not see it, since a unit module is forked per unit after the root is built. An application no longer writes its root as a factory over its kinds for a spec's sake.

The kernel applies the overrides at boot, before the runtime starts, and the drift gate fires there as a `Defect`: a kind the runtime binds no module for, a port that kind's module no longer provides, two overrides for one port in one kind, or one module bound under two kinds. A unit override's error channel must be `never`, as a fork's is — refused at compile time.

`@btravstack/core` exports the `UnitOverrides` set port `overridden` contributes to, and `Runtime` gains an optional `units` record — the modules a runtime forks, by kind — which the three shipped runtimes and `testRuntime` now declare. A hand-rolled runtime that omits it refuses every unit override at boot rather than ignoring it.

`overridden(root, [])` also no longer widens the error channel to `unknown`.
