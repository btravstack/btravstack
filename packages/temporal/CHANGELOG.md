# @btravstack/temporal

## 0.2.0

### Minor Changes

- f9d48ec: **`@btravstack/temporal` becomes a starter, and everything is a provider.**
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

- 2f1974e: The Temporal worker runtime for `@btravstack/core`.

  `temporalRuntime({ connection, taskQueue, workflows, activities, needs })` runs a
  Temporal worker under the kernel's lifecycle: one unit per activity attempt, and
  a drain that releases the kernel at its **own** deadline rather than Temporal's
  `shutdownForceTime` — `@temporalio/worker` exposes no public forced shutdown, so
  stopping the wait is the only escalation available, and the worker keeps winding
  down underneath until the process exits.

  It integrates through `temporal-contract`: add `activityUnits(host)` to
  `declareActivitiesHandler`'s middleware and every activity attempt becomes a
  kernel unit with the application context injected. `temporal-contract` is not a
  peer dependency — the middleware type is structural — and `Result` → activity
  failure is deliberately not mapped here, because `declareActivitiesHandler`
  already does it.

### Patch Changes

- 068399d: **`UnitRecord` gains `signal: AbortSignal`** — the ambient record is five
  fields now, not four. It is the **very** controller the unit's work callback is
  handed, not a copy: one abort, two ways to reach it, fired at the drain
  deadline or at once on a path that skips the drain.

  The gap it closes: a middleware-shaped runtime opens its unit around a call it
  does not own the arguments of. `@btravstack/temporal`'s `activityUnits` and
  `@btravstack/amqp`'s `messageUnits` both hand the kernel a work callback that
  _is_ the library's `next()`, so an activity or a handler had no parameter to
  receive the signal through and the kernel's `drainTimeoutMs` was unobservable
  from inside the work. Injecting a context the transport's contract does not
  type was the alternative, and it is exactly the hidden-dependency shape `di`
  exists to prevent, so the signal travels on the record instead — data about
  this unit, like `deadline`, with nothing to substitute in a test.
  `@btravstack/http` is unchanged: it still passes the same signal as its
  handler's third parameter.

  What each transport does with it is the transport's own business, and both
  examples are worked:

  - **`examples/order-amqp-worker`** answers a `RetryableError` when
    `currentUnit()?.signal.aborted`, leaving the delivery un-acked so the broker
    hands it to the next worker. This transport has no cancellation of its own —
    a redelivery is recovery, not cancellation.
  - **`examples/order-temporal-worker`**'s `ShippingService.arrange` fails as a
    **defect**, which the platform retries on another worker. The contract's
    `ShippingUnavailable` is a permanent no and would be the wrong error for "we
    ran out of time". Temporal's `Context.current().cancellationSignal` is a
    different clock — workflow-side cancellation, and worker shutdown after
    `shutdownGraceTime` — so the two are honoured together rather than one
    standing in for the other.

- Updated dependencies [f133934]
- Updated dependencies [9ca73c5]
- Updated dependencies [ba815e4]
- Updated dependencies [38d7cd5]
- Updated dependencies [4fa693c]
- Updated dependencies [b56501f]
- Updated dependencies [e616e23]
- Updated dependencies [5a271c0]
- Updated dependencies [72b8fbd]
- Updated dependencies [e950473]
- Updated dependencies [068399d]
  - @btravstack/config@1.0.0
  - @btravstack/core@1.0.0
  - @btravstack/di@1.0.0
