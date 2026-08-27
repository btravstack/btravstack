# packages/temporal-worker

The Temporal worker starter's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what only
matters when you are working under `packages/temporal-worker/`. Keep it in sync
with the code in the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`TemporalModule(name)({ contract, activities, workflows, address?,
namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports?, needs? })`** —
  THE way an application writes its worker root; `temporal-module.ts`, the
  same shape as `@btravstack/http-server`'s `HttpModule`. `activities` is the
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
  (`temporal-runtime.ts`) — the activities' port, one id, the starter's own:
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
  `ActivitiesPortOf<C>` and `ActivitiesInstanceOf<C>` are **types**, exported
  from `index.ts` — an application that composes `orderActivities =
TemporalActivities(contract)([piece, piece])` and exports it by name needs
  declaration emit to be able to print that type, and a type built from an
  unexported alias fails TS4023 ("has or is using name 'ID' … but cannot be
  named") the moment a consumer does. `TemporalActivitiesPort` — the
  **value** — stays unexported: nothing outside this package legitimately
  constructs a provider against the bare port (a consumer always goes
  through `TemporalActivities(contract)` or `TemporalWorkflowActivities(contract,
key)`, both of which cast it to the typed alias), so there is nothing a
  type-only export would help with.
- **`TemporalActivities(contract)` → `ReturnType<typeof
Provider<ActivitiesPortOf<C>>>`** — the activities' provider builder,
  `temporal-module.ts`, the same shape as `@btravstack/http-server`'s
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
  `examples/order-temporal-worker/src/slices/fulfillment/activities.ts` and
  `examples/order-temporal-worker/src/slices/billing/activities.ts` are the
  worked examples (no port class, no name, anywhere).

  It also takes **`needs`**, forwarded to di's own — what this root's OWN
  providers expect from outside. The starter's `Env` is not among them: the
  starter is an import, and an import's needs travel without being restated. A
  root that provides a config provider of its own does declare it —
  `examples/order-amqp-worker` says `needs: [Env]` for `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

  A third call composes **pieces** instead of a record:
  `TemporalActivities(contract)([piece, piece, ...])`, one piece per
  `TemporalWorkflowActivities(contract, key)(deps, arm)`. Its type is an
  intersection with `Compose<C>`, declared **last**: `ReturnType<typeof
Provider<ActivitiesPortOf<C>>> & Compose<C>` — di's builder first, the
  composer last. Reversed, TypeScript reports the FIRST arm's failure on a
  non-covering array, and the diagnostic degrades to `not assignable to
'Qualification<readonly [], Activities>'`, naming nothing; last, it reports
  the composing arm's own conditional against `readonly ["UNCOVERED
ACTIVITIES — …", K]`, which always names the marker — the missing key `K` itself
  appears only when the array's length matches that marker tuple's own length
  of 2; a single-element array's diagnostic names the marker alone —
  measured, not stylistic. The
  composed provider's own `deps` are the array of **piece ports**
  (`InstanceType<T[number]["port"]>` in its return type), not what a piece
  closes over: di constructs each piece first, as its own provider, and the
  composing call's `construct` just reassembles their results into a record
  keyed by what each piece's port id carries past
  `WORKFLOW_ACTIVITIES_PREFIX`. That means the pieces themselves still need
  discharging — typically listed in `provides` alongside `activities`, or
  exported by a slice module imported in — the same as any other unmet need;
  `TemporalModule` does not do this for you, it only prepends `activities`
  itself. `Uncovered` checks that every key has a piece, not that no two
  share one, so two pieces claiming one key type-check together fine.
  Whether di catches the conflict depends on whether **both** end up
  discharged as providers in the same graph: only then are they two
  providers for one port — di's duplicate-provider defect at build. Wire in
  only one of the two and the other's implementation is simply never
  registered — no diagnostic marks the conflict, and "a workflow's
  activities belong to exactly one slice" holds only for the slice actually
  composed in.

- **`TemporalWorkflowActivities(contract, key)` → `ReturnType<typeof
Provider<WorkflowActivitiesPortOf<C, K>>>`** (`workflow-activities.ts`,
  exported from `index.ts`) — one workflow's activities, or a
  **contract-global** activity, as a provider of its own. `key` is any
  top-level key of the activities record `ActivitiesOf<C>` declares — which
  includes a contract-global activity as well as a workflow, so the name is
  imprecise in that one case, deliberately: narrowing the type to workflow
  keys only would cost extra type code and lock a contract with global
  activities out of the split. There is no name to give: the key IS the
  port's name, minted as `` `${WORKFLOW_ACTIVITIES_PREFIX}${key}` ``
  (`WORKFLOW_ACTIVITIES_PREFIX = "TemporalWorkflowActivities:"`, exported
  from `workflow-activities.ts` only) — so the port id carries the key, which
  is what makes two slices claiming one workflow di's duplicate-provider
  defect rather than a silent merge, and what lets the composing form recover
  each piece's key by stripping the prefix back off `piece.port.portId`
  rather than needing it spelled again. `contract` types `key`
  (`ActivitiesKeyOf<C>`, `workflow-activities.ts`-only, unexported — nothing
  outside this file needs to name a bare key) and the piece
  (`ActivitiesOf<C>[K]`, routed through an `extends infer` indirection since
  `ActivitiesOf<C>` is a `NoInfer`-wrapped conditional/mapped intersection
  that TypeScript refuses to index by a generic key directly — the standard
  workaround); a key the contract does not declare is refused at the call —
  there is nothing to type it by. The return is di's own `Provider(port)`, so
  every arm is available exactly as it is on `TemporalActivities(contract)`,
  and the provider carries its port (`WorkflowActivitiesPortOf<C, K>`, a
  **type**, exported from `index.ts` for the same declaration-emit reason
  `ActivitiesPortOf<C>` is — a slice module that exports its own piece by
  name needs it printable) as `provider.port`. `WORKFLOW_ACTIVITIES_PREFIX` —
  the **value** — stays unexported from `index.ts`: an application never
  constructs a port id by hand, so nothing outside this package legitimately
  needs the string.
- **`temporal(options)` → `Module<TemporalRuntime | TemporalConfig |
TemporalConnection, ConfigInvalid | TemporalUnreachable, Env | Scope |
ActivitiesInstanceOf<C>>`** — the starter, the same shape as `@btravstack/http-server`'s
  `http()`. It provides `Runtime<never, TemporalInfo>` on the **`TemporalRuntime`**
  port (a class over core's `RuntimePort`, the package's own now that the
  runtime resolves nothing), **`TemporalConfig`**
  (`{ address, namespace, gracePeriodMs, forceAfterMs }`) bound
  through `Config.provider` from `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`),
  `TEMPORAL_NAMESPACE` (default `default`), `TEMPORAL_GRACE_PERIOD_MS`
  (`10_000`) and `TEMPORAL_FORCE_AFTER_MS` (`15_000`) in the kernel's `Env`, and
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
  `forceAfter` (Temporal's `shutdownForceTime`) and `gracePeriod`
  (`shutdownGraceTime`) — **also pins**, of `TEMPORAL_FORCE_AFTER_MS` and
  `TEMPORAL_GRACE_PERIOD_MS`. They are milliseconds on the config because an
  environment carries strings and Temporal's own `msToNumber` is what turns a
  `Duration` pin (`"10 seconds"`) into the same number, so the two routes reach
  the worker identically. Both have to agree with the kernel's `drainTimeoutMs`,
  which is itself `DRAIN_TIMEOUT_MS` — the whole shutdown budget is set in one
  manifest or pinned in one composition root, never half in each.

  The four fields share ONE `Config.provider`: the fully-pinned shortcut
  provider is gone, because `Config.pinned` already reads nothing and a
  four-field version of that branch would have been unsatisfiable in practice.

  `TemporalTuning` is where `address`/`namespace`/`gracePeriod`/`forceAfter`
  are declared, and `TemporalOptions` and `TemporalModuleOptions` both
  intersect it — one spelling, so the sugar cannot drift from the starter it
  forwards to.

- **The activities port is the starter's, provided by the application, and
  the module's one need.** Its service is `ActivitiesOf<C>` =
  `DeclareActivitiesHandlerOptions<C>["activities"]` — the implementations
  record `declareActivitiesHandler` takes for `C`, with no injected context —
  built by a provider from the application's own services (closures; nothing
  resolved from a `ctx`). Inside, `Provider(TemporalRuntime)({ connection: TemporalConnection,
config: TemporalConfig, activities: TemporalActivitiesPort as
ActivitiesPortOf<C> }, { sync })` —
  the port rides di, which is why `ActivitiesInstanceOf<C>` is in the module's
  `Needs` and a root that imports the starter without providing the
  activities is rejected by `start` for still owing it — by assignability
  against `Env | Scope` on the `module` parameter, not by di's
  `UNSATISFIED DEPENDENCIES` dependency gate, so the diagnostic names the port and
  ends on `Type '"TemporalActivities"' is not assignable to type '"@di/Scope"'`
  (the
  `examples/order-temporal-worker` `needs-gate.test-d.ts` pins that; there is
  no `UNSATISFIED RUNTIME PORTS` arm any more, the runtime resolves nothing).
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
- **The kernel's per-unit `AbortSignal` reaches an activity through that
  record, and only through it.** `host.run` hands one to its work callback,
  and here the callback IS `next()` — an activity has no parameter to receive
  it through, and giving it one would mean injecting a context the contract
  does not type, which was the alternative and was rejected. So an activity
  that must stop when the **kernel** stops waiting reads
  `currentUnit()?.signal`, aborted at `drainTimeoutMs`. Temporal's own
  `Context.current().cancellationSignal` is a **different clock** — a
  workflow-side cancellation, and worker shutdown after `shutdownGraceTime` —
  so the two are honoured together rather than one standing in for the other.
  `examples/order-temporal-worker`'s `ShippingService.arrange` is the worked
  answer: it fails as a **defect** on an aborted signal, which the platform
  retries on another worker, where the contract's `ShippingUnavailable` is a
  permanent no.
- **`@temporal-contract/worker` and `@temporal-contract/contract` are peers**
  (and devDependencies, for the suite). A starter has real dependencies — it
  calls `declareActivitiesHandler` and types `contract` as a
  `ContractDefinition` — and a peer is what makes the application hold one copy.
  `@btravstack/config` is a peer for the same reason `@btravstack/http-server` has it:
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
- **Cross-cutting concerns: the question does not arise here.** There is no
  origin, no preflight and no browser, so CORS and security headers are
  meaningless on this transport, and the connection is already authenticated —
  by Temporal itself, at `TEMPORAL_ADDRESS` and its namespace, before a task is
  polled. Per-activity identity is a **field on the contract's own input**, the
  way `tenantId` already is on every workflow and activity input in
  `examples/order-temporal-worker`, and nothing this package reads. Limiting
  throughput is the Worker's own concurrency options, not a policy slot.
  `@btravstack/contract` is dependency-free, so its marker combinator _would_
  work over a Temporal contract; it is deliberately not wired, because there is
  nothing here to authenticate **from**.
- **`temporal-runtime.spec.ts` carries 13 specs, and `workflow-activities.spec.ts` 2 more — 15 in the package.** One is the published
  info (_"publishes the task queue and namespace it polls"_), four the starter's
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
  graph, closing over the services their provider declared"_), three the drain
  (_"lets an in-flight activity finish while draining"_; _"hands the activity
  the unit's own AbortSignal, through the ambient record"_, the `deadline`
  fixture's activity waiting on `currentUnit()?.signal` and reporting
  `sawAbort` alongside the report's `abandoned: 1`; _"releases the kernel at
  its own deadline, not Temporal's"_).
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
  `workflow-activities.spec.ts`'s two specs run over `test-fixtures.ts`'s
  `slicedContract` — two workflows, one task queue — and `slicesOf`, which
  composes two pieces from `TemporalWorkflowActivities(slicedContract, key)`:
  `runEcho`'s declares `Greeting` and `runShout`'s declares nothing, so the
  spec can tell each piece was built from the ports its OWN provider
  declared (_"serves a record composed from one piece per workflow"_,
  executing the SECOND slice's workflow to prove both were mounted;
  _"builds each piece from the ports its own provider declared"_, off
  `slices.greeting()`). The `serveSliced` fixture composes
  `TemporalModule("Sliced")({ contract: <per-test taskQueue>, activities:
slices.activities, workflows: echoWorkflows, provides: [...slices.pieces,
Provider(Greeting)(...)] })` through `boot` — the pieces are passed to
  `provides` alongside `activities` because the composed provider's own
  `deps` are the pieces' ports, which nothing else in the graph would
  otherwise discharge (the same shape `handler.spec.ts`'s `serveSliced` uses
  in `packages/amqp-worker`). `withTaskQueue(contract, taskQueue)` is what stamps
  the per-test queue onto `slicedContract`: a runtime string can never be the
  contract's own literal `taskQueue` type, so the helper casts internally
  and returns `C` rather than the widened object literal an inline spread
  would — which is what lets `TemporalModule` infer one `C` from `contract`
  and `activities` together instead of two conflicting candidates once
  `activities` is the composing arm's own, more specific, type.
- **`workflow-activities.test-d.ts` pins the composing form's compile-time
  gates**, on a `pinContract` of its own — **six labelled properties, three of
  them negatives**, which is exactly what `@btravstack/amqp-worker`'s
  `handler.test-d.ts` carries: the two are deliberate mirrors and drifted
  apart once (issue #51). A piece typed by its own key
  (`_echoPort`, against `WorkflowActivitiesPortOf`), an array covering every
  declared key composing into what `TemporalModule` takes, a key the contract
  does not declare refused at `TemporalWorkflowActivities`'s own call, an
  array that misses a key refused at `TemporalActivities`'s composing call,
  and a piece built for **another contract** refused there too — and the two
  existing arms (`value`, and a hand-written record) still resolving
  unchanged.

  The wrong-contract negative needs care, and amqp's needed a fix before it
  bit: the port id carries only the KEY, so what separates two pieces for the
  same key is the **service** the port carries. `otherContract`'s `runEcho`
  therefore takes and answers a `number` where `pinContract`'s takes and
  answers a `string`; reuse one shape across both and the two ports are
  structurally identical and the directive sits unused. The raw diagnostic is
  misleading about this: stripped, it reports that the piece's `runEcho` port id
  is not assignable to `runShout`'s, which reads positional and is just one arm
  of the `PieceOf<C>` union being printed. Measured with a third contract whose
  `runEcho` reuses `step` unchanged: composed into the same position of the
  same array, it is **accepted**. The gate is structural on the service, as
  intended. Checked by `tsc -p tsconfig.test-d.json` (`include:
["src/**/*.test-d.ts"]`, extending `tsconfig.json`), which the package's own
  `test:types` script runs and `typecheck` runs alongside the ordinary
  `tsc --noEmit` — the same two-script shape as `@btravstack/amqp-worker`.

- Peer dependencies: `@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
  `unthrown`, `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`,
  `@temporal-contract/worker`, `@temporal-contract/contract`.

- **`traceparent` is deliberately not read here** (issue #64, where http and
  amqp learned it). A workflow's inbound context does not arrive as wire
  headers this starter sees — Temporal's own interceptor ecosystem owns
  cross-workflow propagation — and the workflow/activity id already IS the
  correlation this transport means: minted outside the process, stable across
  every retry and replay, which is exactly what `UnitMeta.traceId` exists to
  carry. A deployment that wants full OTel propagation through Temporal wires
  Temporal's own OpenTelemetry interceptors beside `otel()`, not through this
  package.
