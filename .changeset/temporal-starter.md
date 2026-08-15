---
"@btravstack/temporal": minor
---

**`@btravstack/temporal` becomes a starter, and everything is a provider.**
`temporal({ contract, activities, workflows, address?, namespace?, gracePeriod?,
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
`activities` port.

**Breaking.** `temporalRuntime`, `activityUnits`, `ActivityMiddleware`,
`ActivityUnitContext` and `TemporalOptions.needs` / `connection` / `taskQueue`
/ `activities(host)` are gone. `activities` is now a **port** the application
provides — its service the implementations record `declareActivitiesHandler`
takes for `contract`, with no injected context, built by a provider closing
over the application's own services — and a need of the starter's module: the
runtime resolves nothing from a `ctx`, `needs` is `never`, and a composition
root without the activities module is rejected by `start` for still owing the
port. The starter calls `declareActivitiesHandler` itself, inside its error
qualifier, with its unit middleware in place; the middleware injects nothing.
`@temporal-contract/worker`, `@temporal-contract/contract` and
`@btravstack/config` join the peer dependencies.

**`TemporalModule(name)({...})` is the way an application writes its worker
root.** `TemporalModule(name)({ contract, activities, workflows, address?,
namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports? })` is
`Module(name)({...})` for a Temporal worker: `activities` is the **provider**
of the activities port (a plain `Provider` whose instance is constrained to
the implementations record for `contract`), and the sugar imports the starter,
provides the activities and exports `TemporalRuntime` — handing the augmented
lists to di's own `Module(name)({...})`, whose return type is the sugar's, so
`start`'s gate and di's see nothing new. `temporal()` stays exported as the primitive
it delegates to. `TemporalModuleOptions` is exported for the type.

**`TemporalActivities(contract)(name)` mints the activities port and its
provider in one call.** The first call fixes the contract, the second mints a
port named `name` whose service is the implementations record
`declareActivitiesHandler` takes for it, and what comes back is di's own
`Provider(port)` builder — `(deps, arm)` with the usual typing, returning a
provider that carries the port typed as `provider.port`. The hand-declared
`class extends Port(name)<…>` line disappears; the port is typed as di's
`PortClassOf<Name, ActivitiesOf<C>>`. A hand-declared port plus
`Provider(port)` still works.
