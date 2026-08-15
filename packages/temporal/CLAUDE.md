# packages/temporal

The Temporal worker starter's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what only
matters when you are working under `packages/temporal/`. Keep it in sync
with the code in the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`TemporalModule(name)({ contract, activities, workflows, address?,
namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports? })`** —
  THE way an application writes its worker root; `temporal-module.ts`, the
  same shape as `@btravstack/http`'s `HttpModule`. `activities` is the
  **provider** of the activities port — a plain `Provider<ActivitiesInstance,
ActivitiesError, ActivitiesNeeds>` whose instance is constrained on the type
  parameter (`ActivitiesInstance extends PortInstance<string,
ActivitiesOf<C>>`), so a provider of anything but the implementations record
  for `contract` fails there. It delegates to `temporal({ contract,
activities: activities.port as never, workflows, … })` and hands the augmented
  tuples — `Imports<I, ActivitiesInstance>` / `Provides<P, ActivitiesInstance,
ActivitiesError, ActivitiesNeeds>`, readonly and exact — to di's own
  `Module(name)({...})`, whose return type IS the sugar's: nothing spelled
  twice (di exports `AnyModule`, `AnyProvider`, `Exportable` for the tuple
  constraints; a named generic alias for the return was tried and removed,
  TS2883). The starter's type in that tuple is always `Module<Provided,
ConfigInvalid | TemporalUnreachable, Env | Scope | ActivitiesInstance>`, pins
  or not — `Env` is discharged by `start` anyway. `TemporalModuleOptions`
  is exported for the type. Covered by `test-fixtures.ts`'s `boot`, which is
  written with it. `temporal()` stays exported as the primitive it delegates
  to.
- **`TemporalActivities(contract)(name)` → `ReturnType<typeof
Provider<PortClassOf<Name, ActivitiesOf<C>>>>`** — the activities' port and
  provider in one call, `temporal-module.ts`, the same shape as
  `@btravstack/http`'s `HttpRouter(name)`. The first call fixes `C` (the
  contract value is otherwise unused; it exists so `C` is inferred rather than
  written), the second mints `class extends Port(name)<ActivitiesOf<C>> {}`
  and returns di's own `Provider(port)` builder, so the third call is di's
  `(deps, arm)` unchanged and the provider it returns carries the port typed
  (`orderActivities.port`). The class is cast to di's **`PortClassOf<Name,
ActivitiesOf<C>>`** (`{ portId: Name; new (): PortInstance<Name,
ActivitiesOf<C>> }`, the one nameable spelling of a minted port class) because
  the class expression's own type expands the brand keys in declaration emit
  and cannot be named (TS4023). This is the
  way an application declares its activities; a hand-declared port class plus
  `Provider(port)` remains possible. `test-fixtures.ts` mints `EchoActivities`
  with it and builds all four fixture providers off the one builder, and
  `examples/order-temporal-worker/src/activities.ts` is the worked example
  (no port class anywhere; `orderActivities.port` where the port is named).
- **`temporal(options)` → `Module<TemporalRuntime | TemporalConfig |
TemporalConnection, ConfigInvalid | TemporalUnreachable, Env | Scope |
InstanceType<A>>`** — the starter, the same shape as `@btravstack/http`'s
  `http()`. It provides `Runtime<never, TemporalInfo>` on the **`TemporalRuntime`**
  port (a class over core's `RuntimePort`, the package's own now that the
  runtime has no needs), **`TemporalConfig`** (`{ address, namespace }`) bound
  through `Config.provider` from `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`)
  and `TEMPORAL_NAMESPACE` (default `default`) in the kernel's `Env`, and
  **`TemporalConnection`** (a `NativeConnection`) as a **resourceful** provider
  from `[TemporalConfig]` — `acquire: NativeConnection.connect`, `release:
close`, failure the modeled **`TemporalUnreachable`** `{ address, cause }`.
  `TemporalOptions<C, A>`: `contract` (a `temporal-contract` contract; the task
  queue is read off it), `activities` (a **port**, see below), `workflows` (a
  `WorkflowSource`: `{ workflowsPath }` or `{ workflowBundle }`), `address?` /
  `namespace?` (**pins** — explicit > env > default, per field, through
  `Config.pinned(value, field)`; a pinned field reads nothing from the
  environment, and the declared `Env` need and `ConfigInvalid` stay whatever is
  pinned — one signature, no overload pair: the kernel discharges the one, a
  pinned config never produces the other),
  `forceAfter` (Temporal's `shutdownForceTime`, default `15 seconds`) and
  `gracePeriod` (`shutdownGraceTime`, default `10 seconds`). `TemporalInfo` is
  `{ taskQueue, namespace }`, published on `Serving.info` once polling. The
  worked example is `TemporalModule("OrderTemporalWorker")({ contract,
activities: orderActivities, workflows, imports: [Application, Persistence,
Fulfillment] })` + `runMain(OrderTemporalWorker)`; a test passes `env: {
TEMPORAL_ADDRESS }` to `start`.
- **`activities` is a port the application provides, and a need of the
  module.** Its service is `DeclareActivitiesHandlerOptions<C>["activities"]` —
  the implementations record `declareActivitiesHandler` takes for `C`, with no
  injected context — built by a provider from the application's own services
  (closures; nothing resolved from a `ctx`). The constraint is at the call
  site, `activities: A & ActivitiesPort<A, C>` (`unknown` when `ServiceOf<A>`
  is that record, `never` otherwise — the same trick as `@btravstack/orpc`'s
  `RouterPort`), so a wrong port fails on `temporal(...)`. Inside,
  `Provider(TemporalRuntime)([TemporalConnection, TemporalConfig,
options.activities], { sync })` — the port rides di, which is why
  `InstanceType<A>` is in the module's `Needs` and a root without the
  activities module is rejected by `start` for still owing it (the
  `examples/order-temporal-worker` `needs-gate.test-d.ts` pins that; there is
  no `UNSATISFIED RUNTIME NEEDS` arm any more, the runtime needs nothing). The
  one cast in the package is `impls as ActivitiesOf<C>` in that `sync`: the
  call-site constraint is not visible inside a body where `A` is unresolved.
- **The starter calls `declareActivitiesHandler` itself**, in `start(host)`,
  with `activityUnits(host)` in the middleware slot — **inside** the qualified
  chain (`fromThrowable`), not before it: it throws on a contract it cannot
  satisfy (an implementation the contract never declared, one it declares and
  finds missing), and that throw is a startup failure like any other —
  `Err(RuntimeStartFailed)`, exit `1`, not a `Defect` and exit `70`.
- **`activityUnits(host)` is internal** (`activity-units.ts`, not exported).
  It opens one kernel unit per activity **attempt** (`id` is the base64 task
  token, `traceId` the workflow id) and injects nothing — `next()` — since an
  activity is a closure over its provider's services; the ambient
  `currentUnit()` record is what an adapter reads the trace id from. Its type
  is `temporal-contract`'s own `ActivityMiddleware`, imported: with the
  library a peer there is no structural copy, no cast and no
  `oxlint-disable` left in that file.
- **`@temporal-contract/worker` and `@temporal-contract/contract` are peers**
  (and devDependencies, for the suite). A starter has real dependencies — it
  calls `declareActivitiesHandler` and types `contract` as a
  `ContractDefinition` — and a peer is what makes the application hold one copy.
  `@btravstack/config` is a peer for the same reason `@btravstack/http` has it:
  `TemporalConfig` is bound through `Config.provider`.
- **The drain is the reason the package exists.** `Serving.drain` calls
  `worker.shutdown()` then waits on `run()` **raced against the kernel's
  deadline signal**, and keeps the signal so `stop()` is released by the same
  abort. `@temporalio/worker` exposes no public forced shutdown
  (`Worker.forceShutdown$` is `protected`, `Runtime.shutdown()` is
  process-global), so stopping the wait is the only escalation: the kernel is
  released on time, the work is reported `abandoned`, and the worker keeps
  winding down on Temporal's clock until the process exits.
- **Not included, deliberately**: `Result` → activity failure, which
  `declareActivitiesHandler` already owns. Doing it twice is what the removal of
  the raw-worker path was about.
- **`temporal-runtime.spec.ts` carries 12 specs.** Four are the starter's
  configuration (_"binds TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE from the
  environment when nothing is pinned"_, _"pins what it is given and reads the
  rest from the environment"_, _"reads nothing from the environment when both
  are pinned"_, _"fails startup with ConfigInvalid for TemporalConfig when
  TEMPORAL_NAMESPACE is blank"_ — through the `configured` fixture's
  `BoundConfig` tap), one the connection (_"reports a Temporal service it
  cannot reach as TemporalUnreachable, not a defect"_, against `127.0.0.1:1`),
  two the qualified startup chain (a bundle that will not build; an activities
  record with an undeclared implementation, the `undeclared` provider), two the
  unit boundary (_"opens one kernel unit per activity attempt"_ reads
  `currentUnit()?.traceId` from inside the attempt — the meta itself is no
  longer observable from outside the starter, and once a `traceId` is supplied
  the kernel never reads `meta.id` again; _"builds the activities from the
  graph, closing over the services their provider declared"_), two the drain.
  All boot through the `env` fixture (one `TestWorkflowEnvironment` per test)
  and `test-fixtures.ts`'s `boot`: `TemporalModule("Worker")({ contract: {
...echoContract, taskQueue }, activities: <the provider under test>,
workflows, provides: [Greeting] })`, `env: { TEMPORAL_ADDRESS: env.address }`
  — a per-test connection measured as free.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
  `unthrown`, `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`,
  `@temporal-contract/worker`, `@temporal-contract/contract`.
