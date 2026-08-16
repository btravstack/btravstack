---
"@btravstack/temporal": minor
---

**`@btravstack/temporal` becomes a starter, and everything is a provider.**
`temporal({ contract, workflows, address?, namespace?, gracePeriod?,
forceAfter? })` is a module providing `TemporalRuntime` (a `Runtime<never,
TemporalInfo>` on the package's own port over `RuntimePort`), `TemporalConfig`
(`{ address, namespace }`, bound from `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`
unless pinned — explicit beats environment beats default, per field, through
`Config.pinned`; a pinned field reads nothing from the environment, and the
declared `Env` need and `ConfigInvalid` stay whatever is pinned) and
`TemporalConnection` (the `NativeConnection`
as a resource of the graph, opened with the scope and closed on every exit
path; a service that will not answer is the modeled `TemporalUnreachable`).
Import it next to the application, export `TemporalRuntime`, and provide the
activities on the starter's own activities port.

**Breaking.** `temporalRuntime`, `activityUnits`, `ActivityMiddleware`,
`ActivityUnitContext` and `TemporalOptions.needs` / `connection` / `taskQueue`
/ `activities(host)` are gone. The activities are now provided on the
**starter's own port** — one id, `Port("TemporalActivities")`, framework-owned
like `TemporalConfig`, since a worker serves one activities record as it
polls one task queue; typed per contract at the type level, so a provider
built for one contract cannot be handed to a module declaring another — its
service the implementations record `declareActivitiesHandler` takes for
`contract`, with no injected context, built by a provider closing over the
application's own services. That port is a need of the starter's module: the
runtime resolves nothing from a `ctx`, `needs` is `never`, and a composition
root that provides no activities is rejected by `start` for still owing the
port. The starter calls `declareActivitiesHandler` itself, inside its error
qualifier, with its unit middleware in place; the middleware injects nothing.
`@temporal-contract/worker`, `@temporal-contract/contract` and
`@btravstack/config` join the peer dependencies.

**`TemporalModule(name)({...})` is the way an application writes its worker
root.** `TemporalModule(name)({ contract, activities, workflows, address?,
namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports? })` is
`Module(name)({...})` for a Temporal worker: `activities` is the **provider**
on the starter's activities port for `contract` (what `TemporalActivities`
returns; one built for another contract is refused), and the sugar imports the starter,
provides the activities and exports `TemporalRuntime` — handing the augmented
lists to di's own `Module(name)({...})`, whose return type is the sugar's, so
`start`'s gate and di's see nothing new. `temporal()` stays exported as the primitive
it delegates to. `TemporalModuleOptions` is exported for the type.

**`TemporalActivities(contract)` is the activities provider builder.** The
one call fixes the contract and hands back di's own `Provider(port)` on the
starter's activities port typed for it — `(deps, arm)` with the usual typing,
returning a provider that carries the port typed as `provider.port` (di's
`PortClassOf<"TemporalActivities", ActivitiesOf<C>>`). There is no name to
give and no hand-declared `class extends Port(name)<…>` line. A hand-written
`Provider(port)` over the same port still works.
