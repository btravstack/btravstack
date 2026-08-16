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
  **provider** of the starter's activities port for THIS contract — a plain
  `Provider<ActivitiesInstanceOf<C>, ActivitiesError, ActivitiesNeeds>`, which
  is what `TemporalActivities(contract)(deps, arm)` returns — so a provider
  of anything but the implementations record for `contract` fails there
  (structurally, on the record: one built for another contract is refused).
  It delegates to `temporal({ contract, workflows, … })` and hands the
  augmented tuples — `Imports<I, C>` / `Provides<P, C, ActivitiesError,
ActivitiesNeeds>`, readonly and exact — to di's own
  `Module(name)({...})`, whose return type IS the sugar's: nothing spelled
  twice (di exports `AnyModule`, `AnyProvider`, `Exportable` for the tuple
  constraints; a named generic alias for the return was tried and removed,
  TS2883). The starter's type in that tuple is always `Module<Provided,
ConfigInvalid | TemporalUnreachable, Env | Scope | ActivitiesInstanceOf<C>>`,
  pins or not — `Env` is discharged by `start` anyway. `TemporalModuleOptions`
  is exported for the type. Covered by `test-fixtures.ts`'s `compose`, which
  is written with it. `temporal()` stays exported as the primitive it
  delegates to.
- **`TemporalActivitiesPort` / `ActivitiesPortOf<C>` / `ActivitiesInstanceOf<C>`**
  (`temporal-runtime.ts`, exported from the file for the package's own tests,
  **not** from `index.ts`) — the activities' port, one id, the starter's own:
  `Port("TemporalActivities")`, declared once. A worker serves one activities
  record as it polls one task queue (thesis #1), so there is nothing to name
  and the port is framework-owned like `TemporalConfig`; two providers for it
  in one graph are di's duplicate-provider defect at build, which is correct.
  It is **generic at the value level and typed per contract at the type
  level** — `ActivitiesPortOf<C>` is `PortClassOf<"TemporalActivities",
ActivitiesOf<C>>`, `ActivitiesInstanceOf<C>` its `PortInstance` — the same
  move the kernel's `RuntimePort` makes, so one `Port(...)` call (no
  duplicate-id warning however many contracts instantiate it) still refuses a
  provider built for one contract handed to a module declaring another.
- **`TemporalActivities(contract)` → `ReturnType<typeof
Provider<ActivitiesPortOf<C>>>`** — the activities' provider builder,
  `temporal-module.ts`, the same shape as `@btravstack/http`'s
  `HttpRouter(contract)`. The one call fixes `C` (the contract value is
  otherwise unused; it exists so `C` is inferred rather than written) and
  returns di's own `Provider(port)` on `TemporalActivitiesPort as
ActivitiesPortOf<C>`, so the next call is di's `(deps, arm)` unchanged and
  the provider it returns carries the port typed (`orderActivities.port`, for a
  hand-declared provider or a type test). No name, no class line. This is
  the way an application declares its activities; a hand-written
  `Provider(port)` over the same port remains possible. `test-fixtures.ts`'s
  `EchoActivities = TemporalActivities(echoContract)` builds all four fixture
  providers off the one builder, and
  `examples/order-temporal-worker/src/activities.ts` is the worked example
  (no port class, no name, anywhere).
- **`temporal(options)` → `Module<TemporalRuntime | TemporalConfig |
TemporalConnection, ConfigInvalid | TemporalUnreachable, Env | Scope |
ActivitiesInstanceOf<C>>`** — the starter, the same shape as `@btravstack/http`'s
  `http()`. It provides `Runtime<never, TemporalInfo>` on the **`TemporalRuntime`**
  port (a class over core's `RuntimePort`, the package's own now that the
  runtime has no needs), **`TemporalConfig`** (`{ address, namespace }`) bound
  through `Config.provider` from `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`)
  and `TEMPORAL_NAMESPACE` (default `default`) in the kernel's `Env`, and
  **`TemporalConnection`** (a `NativeConnection`) as a **resourceful** provider
  from `[TemporalConfig]` — `acquire: NativeConnection.connect`, `release:
close`, failure the modeled **`TemporalUnreachable`** `{ address, cause }`.
  `TemporalOptions<C>`: `contract` (a `temporal-contract` contract; the task
  queue is read off it, and the activities port is typed by it — see below;
  there is no `activities` option, the module **needs** the port), `workflows` (a
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
- **The activities port is the starter's, provided by the application, and
  the module's one need.** Its service is `ActivitiesOf<C>` =
  `DeclareActivitiesHandlerOptions<C>["activities"]` — the implementations
  record `declareActivitiesHandler` takes for `C`, with no injected context —
  built by a provider from the application's own services (closures; nothing
  resolved from a `ctx`). Inside, `Provider(TemporalRuntime)([TemporalConnection,
TemporalConfig, TemporalActivitiesPort as ActivitiesPortOf<C>], { sync })` —
  the port rides di, which is why `ActivitiesInstanceOf<C>` is in the module's
  `Needs` and a root that imports the starter without providing the
  activities is rejected by `start` for still owing it (the
  `examples/order-temporal-worker` `needs-gate.test-d.ts` pins that; there is
  no `UNSATISFIED RUNTIME NEEDS` arm any more, the runtime needs nothing).
  `TemporalActivitiesPort as ActivitiesPortOf<C>` (here and in
  `TemporalActivities`) is the only cast the record meets: the port is one
  generic value, the type it carries for `C` is what `sync` reads `impls`
  through, and the former `impls as ActivitiesOf<C>` is gone.
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
  and `test-fixtures.ts`'s `compose`: `TemporalModule("Worker")({ contract: {
...echoContract, taskQueue }, activities: <the provider under test>,
workflows, provides: [Greeting] })`, `env: { TEMPORAL_ADDRESS: env.address }`
  — a per-test connection measured as free — handed to the `boot` fixture,
  `@btravstack/testing`'s `bootFixture()`, which `serve` and `serveBroken`
  both depend on: every app is stopped when the test ends (`env` is torn
  down after them, cleanup running in reverse dependency order), and the
  teardown is **Defect-only** — a shutdown defect fails the test, a modeled
  `Err` passes — so `serveBroken`'s `Err` exit is the test's own to assert
  on `app.exited`, not the fixture's.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
  `unthrown`, `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`,
  `@temporal-contract/worker`, `@temporal-contract/contract`.
