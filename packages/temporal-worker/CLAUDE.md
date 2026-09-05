# packages/temporal-worker

The Temporal worker starter's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what only
matters when you are working under `packages/temporal-worker/`. Keep it in sync
with the code in the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`TemporalModule(name)({ contract, activities, workflows, address?,
namespace?, gracePeriod?, forceAfter?, unit?, imports?, provides?, exports?, needs? })`** —
  THE way an application writes its worker root; `temporal-module.ts`, the
  same shape as `@btravstack/http-server`'s `HttpModule`. `activities` is the
  **provider** of the starter's activities port for THIS contract — a plain
  `Provider<ActivitiesInstanceOf<C>, ActivitiesError, ActivitiesNeeds>`, which
  is what `TemporalActivities(contract)({ inject, ...arm })` returns — so a provider
  of anything but the implementations record for `contract` fails there
  (structurally, on the record: one built for another contract is refused).
  It delegates to `temporal({ contract, workflows, … })` and hands the
  augmented tuples — `Imports<I, C, Unit>` / `Provides<P, C, ActivitiesError,
ActivitiesNeeds>`, readonly and exact — to di's own
  `Module(name)({...})`, whose return type IS the sugar's: nothing spelled
  twice (di exports `AnyModule`, `AnyProvider`, `Exportable` for the tuple
  constraints; a named generic alias for the return was tried and removed,
  TS2883). The starter's type in that tuple is always `Module<Provided,
ConfigInvalid | TemporalUnreachable, Env | Scope | ActivitiesInstanceOf<C> |
UnitNeedsOf<Unit>>`,
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
  `OrpcRouter(contract)`. The one call fixes `C` (the contract value is
  otherwise unused; it exists so `C` is inferred rather than written) and
  returns di's own `Provider(port)` on `TemporalActivitiesPort as
ActivitiesPortOf<C>`, so the next call is di's `{ inject, ...arm }` unchanged and
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
  `TemporalWorkflowActivities(contract, key)({ inject, unit?, sync })`. Its type is an
  intersection with `Compose<C>`, declared **last**: `ReturnType<typeof
Provider<ActivitiesPortOf<C>>> & Compose<C>` — di's builder first, the
  composer last. Reversed, TypeScript reports the FIRST arm's failure on a
  non-covering array, and the diagnostic degrades to `not assignable to
'Qualification<readonly [], Activities>'`, naming nothing; last, it reports
  the composing arm's own conditional against `readonly ["UNCOVERED
ACTIVITIES — …", K]`, which always names the marker. The refusal is a tuple **as
  long as the array the caller wrote** — its head the caller's own elements,
  which match, its last element the marker paired with the missing key — so
  the diagnostic on the trailing element names both at every arity (measured
  at one element: `readonly ["UNCOVERED ACTIVITIES — …", "audit" |
"runShout"]`). A fixed two-element tuple named the key only at exactly two. The
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

- **`TemporalWorkflowActivities(contract, key)({ inject, unit?, sync })`**
  (`workflow-activities.ts`,
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
  there is nothing to type it by. The piece
  carries its port (`WorkflowActivitiesPortOf<C, K>`, a
  **type**, exported from `index.ts` for the same declaration-emit reason
  `ActivitiesPortOf<C>` is — a slice module that exports its own piece by
  name needs it printable) as `provider.port`. `WORKFLOW_ACTIVITIES_PREFIX` —
  the **value** — stays unexported from `index.ts`: an application never
  constructs a port id by hand, so nothing outside this package legitimately
  needs the string.

  **It is `{ inject, unit?, sync }`, not di's whole arm set.** `sync`'s return
  type is `ActivitiesRecordOf<C, { unit: UnitRecordOf<U> }>[K]` — the entry
  typed by the record THIS piece declared — while the port it lands on stays
  `ActivitiesRecordOf<C>[K]`, the context-free shape the composed record hands
  `declareActivitiesHandler`. That split is what carries `U` at all, and it is
  what makes `context.unit` contextually typed inside the `sync` literal.
  **The arm set was narrowed for consistency**: `@btravstack/http-server`'s
  `api.OrpcController(contract, path)` and `@btravstack/amqp-worker`'s
  `AmqpHandler(contract, key)` are both `{ inject, unit?, sync }`, and this is
  the same piece under a third transport — one arm across all three is one
  surface to learn and one to keep. `inject: {}, sync: () => activities` is
  what a piece with no services now writes.

  **`unit` declares the ports the activities read off `context.unit`**,
  resolved out of the fork the attempt opened, and the piece keeps the record
  on `piece.unit` plus a phantom `_declared` carrying their instances. The
  phantom is what the root's gate reads (below); `piece.unit` is what the
  wrapper resolves against. A piece that declares none is typed `{}` and pays
  nothing.

  **The record is built by a wrapper on the piece, not by the middleware**, and
  that is the decision. `activityUnits` leaves the forked `Context` on the
  invocation's context under a symbol; each piece's `sync` return is wrapped
  once, as di constructs it, so an attempt costs one `unitRecordOf` and one
  context object. Two things fall out of it. A `key → record` map threaded from
  the composing call into `createWorker` could not reach a hand-composed
  `temporal({ contract })`, which takes its activities as a NEED and never sees
  the provider — the record travelling WITH the piece that declared it has no
  such hole. And the middleware sees Temporal's **flat** activity name
  (`invocation.activityName`) while a piece is keyed by the top-level record
  key, which would have made that map a name translation as well; wrapping the
  implementation itself makes the question moot, since the wrapper is already
  where the name resolves.

  **The wrapper reaches inside two entry shapes**, which is where Temporal
  differs from `@btravstack/amqp-worker`'s `handler | [handler, options]`: a
  workflow key's entry is a **record** of implementations and a
  contract-global key's entry is the implementation itself, so `withUnit`
  wraps a function directly and maps a record's values. Both are covered by
  the `scoped` fixture's pair of pieces, driven by one workflow.

- **`temporal(options)` → `Module<TemporalRuntime | TemporalConfig |
TemporalConnection, ConfigInvalid | TemporalUnreachable, Env | Scope |
ActivitiesInstanceOf<C> | UnitNeedsOf<Unit>>`** — the starter, the same shape as `@btravstack/http-server`'s
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
  `TemporalOptions<C, Unit>`: `contract` (a `temporal-contract` contract; the task
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

  `TemporalTuning<Unit>` is where `address`/`namespace`/`gracePeriod`/`forceAfter`/`unit`
  are declared, and `TemporalOptions` and `TemporalModuleOptions` both
  intersect it — one spelling, so the sugar cannot drift from the starter it
  forwards to.

  **`unit?: { activity?: Unit }`** — the module that `activityUnits`, the
  worker's dispatch middleware, forks around every activity attempt, **seeded
  with the validated input on `ActivityInput(contract)`**.
  Built after the activity is invoked, before it runs; torn down when
  the unit closes. There is exactly ONE kind, `activity`: an attempt is an
  attempt, where `@btravstack/http-server` has a kind per authentication
  scheme, so no fallback question arises and an unbound `unit` simply forks
  nothing.
  `Unit extends AnyUnitModule | undefined = undefined` bounds both
  `temporal()`'s and `TemporalModule`'s own type parameter, the same
  contravariant-exports bound `@btravstack/amqp-worker`'s `unit.message` and
  `@btravstack/http-server`'s `unit.anonymous` use, so a bound module's own
  unmet needs join the starter's `Needs` channel as `UnitNeedsOf<Unit>` — a
  composition root that binds a `unit` owing a port it does not supply is
  refused the same way an unmet activities port is. With no `unit` bound,
  dispatch is unchanged: `activityUnits` calls `next()` directly, and every
  piece's `context.unit` is `{}`.

- **`ActivityInput(contract)` → `ActivityInputPortOf<C>`**
  (`workflow-activities.ts`, exported from `index.ts` with `ActivityInputOf<C>`
  and `ActivityInputPortOf<C>`) — the validated activity input as a port, and
  **the one thing the fork is seeded with**. A `unit.activity` module names it
  in `needs` and derives whatever the application scopes by — a tenant, a
  correlation id — from the invocation itself rather than from an ambient
  record, which is thesis #2's line about what ambient carries.

  One `Port("ActivityInput")` call, cast per contract at the type level — the
  move `TemporalActivitiesPort` makes, so no contract instantiating it warns
  about a duplicate id while a module built for one contract still cannot read
  another's input. `ActivityInputOf<C>` is the union of every activity's own
  input, workflow-local and contract-global alike, reached through each
  implementation's **second parameter**: `WorkerInferInput` is declared by
  `@temporal-contract/worker` and exported from none of its subpaths, so the
  by-index route is the only one open.

  **The seed is subtracted from what the unit module owes.** `UnitNeedsOf`
  excludes `ActivityInputInstance` beside `Scope`, so a module whose `needs`
  name the input port does not surface it at `start` — the fork discharges it
  — while everything else it needs still does.

- **`TemporalModule` GATES `unit.activity` against what the pieces declared.**
  A piece's `unit: { tenant: Tenant }` is a promise the ROOT has to keep —
  `context.unit.tenant` resolves out of the fork, so a bound module that does
  not export `Tenant` defects at the first attempt, and no other check catches
  it: the piece and the root are typed independently.
  `UnitGate<Unit, Declared>` (`unit.ts`, a local copy of
  `@btravstack/amqp-worker`'s rather than a cross-package import) is `unknown`
  when `Exclude<Declared, UnitExportsOf<Unit>>` is `never`, and otherwise the
  repo's required-property marker,
  `"UNIT DOES NOT PROVIDE — a piece injects a port the bound unit module does not export"`,
  carrying the offending port — which is what TypeScript prints (measured:
  `… : Tenant`).

  `Declared` is inferred from the activities provider's own `_declaredUnit`
  phantom, the union of every piece's `_declared` collected by
  `TemporalActivities(contract)([...])` — the composing arm is the only place
  the pieces are known. The gate is intersected onto the **whole options
  record**, the way `NeedsGate` is, rather than onto `unit.activity`: a gate on
  a property is not read when the property is absent, and a root that declares
  a piece's `unit:` and then binds no module AT ALL is exactly the case worth
  catching. `temporal-runtime.test-d.ts` pins both negatives — wrong module,
  and none — beside the positive.

  **`temporal()` is not gated, and that is structural** — the same reason
  `@btravstack/amqp-worker`'s `amqp()` and `@btravstack/http-server`'s
  `http()` are not. It takes its activities as a NEED, never as a value, so
  there is nothing to read a `_declaredUnit` off. A hand-composed root that
  wants the gate goes through `TemporalModule`.

  What that costs is worth stating, because it is the one path where a
  declared port is not checked: a piece declaring `unit: { tenant: Tenant }`
  under a `temporal()` root with no module bound reads `undefined` off
  `context.unit.tenant`, and the property access after it throws. That is a
  **Defect**, which `declareActivitiesHandler` re-throws at the activity edge
  with its original cause — so Temporal fails that attempt with the raw
  `TypeError` rather than a modeled `ApplicationFailure`, and the contract's
  own retry policy decides whether it comes back. Loud, on the first attempt,
  never a silent wrong answer. The gate turns it into a compile error.

- **The activities port is the starter's, provided by the application, and
  the module's one need.** Its service is `ActivitiesOf<C>` =
  `DeclareActivitiesHandlerOptions<C>["activities"]` — the implementations
  record `declareActivitiesHandler` takes for `C`, with no injected context —
  built by a provider from the application's own services (closures; nothing
  resolved from a `ctx`). Inside, `Provider(TemporalRuntime)({ inject: { connection: TemporalConnection,
config: TemporalConfig, activities: TemporalActivitiesPort as
ActivitiesPortOf<C> }, sync })` —
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
  token, `traceId` the workflow id). With a `unit.activity` bound it forks that
  module, seeded `[[ActivityInputPort, invocation.input]]`, and passes the
  forked `Context` down under `UNIT_SCOPE` — a symbol, so a piece written
  against the `{ inject, sync }` arm destructures `context` without an internal
  key sitting in it. It injects nothing else: an activity is a closure over its
  provider's services, and the ambient
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
- **`temporal-runtime.spec.ts` carries the starter's specs, and
  `workflow-activities.spec.ts` the slicing ones.** One is the published
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
  graph, closing over the services their provider declared"_), two the seeded
  fork (_"hands a piece the ports it declared, built from the seeded input"_,
  over the `scoped` fixture: an `activity` module deriving a `Tenant` from
  `ActivityInput(scopedContract)` and two pieces declaring it — one a
  workflow's record, one a contract-global implementation, so ONE workflow run
  drives both of `withUnit`'s entry shapes and the value each reads off
  `context.unit.tenant` could only have come through the seed; and, on the
  sliced worker, _"hands a piece that declared nothing an empty record"_,
  which is `unitRecordOf`'s no-module-bound branch), three the drain
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
  gates**, on a `pinContract` of its own, mirroring
  `@btravstack/amqp-worker`'s `handler.test-d.ts` property for property: the
  two are deliberate mirrors and drifted
  apart once (issue #51). A piece typed by its own key
  (`_echoPort`, against `WorkflowActivitiesPortOf`), an array covering every
  declared key composing into what `TemporalModule` takes, a key the contract
  does not declare refused at `TemporalWorkflowActivities`'s own call, an
  array that misses a key refused at `TemporalActivities`'s composing call,
  and a piece built for **another contract** refused there too — plus the
  declaring pair: a piece whose `unit: { tenant: Tenant }` types
  `context.unit.tenant` inside its own `sync` literal, and a name it did not
  declare refused as TypeScript's own "property does not exist". The record
  arm on `TemporalActivities(contract)` still resolves unchanged.

  **`temporal-runtime.test-d.ts` pins the ROOT's gate**, on a contract of its
  own: `start(TemporalModule(...))` over a bound module that exports what the
  piece injects — one line asserting both that the gate clears and that the
  module's own `needs: [ActivityInput(contract)]` never surfaced as an unmet
  need — beside two negatives, a module exporting something else and no module
  bound at all, and a positive for a root whose pieces declare nothing.

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

## RED metrics: on by default, per ATTEMPT

`btravstack.temporal.activity.attempts` (counter) and
`btravstack.temporal.activity.duration` (histogram, ms), both dimensioned
`{ activity, outcome }`, recorded in the activity middleware. Every unit is handed to `Observers`, and this module contributes a no-op
member of its own — so a graph composing no observability owes nothing — an operation costs one
inert call per module that reads the port. There is no `instrumented` flag: composing `observability()`
and `otel()` is what turns the lines and the instruments on.

**Per attempt, not per activity, and that is the point.** An activity is
retried under the same execution, so a count per activity would hide exactly
the retries worth alerting on — a downstream failing for ten minutes would show
as one slow activity rather than as a rate. It is the same reasoning that makes
`UnitMeta.id` the task token rather than the workflow id.

**The workflow id is not a dimension and must not be.** It is unbounded, and it
is already the unit's `traceId` — which is where an unbounded correlation value
belongs. `activityType` is bounded by the contract.

## `ensureSchedule` — from `@btravstack/temporal-worker/schedule`

`ensureSchedule(schedules, workflowName, options)` →
`AsyncResult<"created" | "updated", WorkflowNotInContractError | WorkflowValidationError | ScheduleNotFoundError>`,
where `schedules` is `@temporal-contract/client`'s `TypedScheduleClient` —
reached as `typedClient.for(contract).schedule` — and `options` is its own
`TypedScheduleCreateOptions`. `@temporal-contract/client` is an **optional
peer** behind the subpath, the `@btravstack/observability/pino` protocol: a
consumer that never imports it installs nothing.

**It exists for idempotence and nothing else.** The typed client's `create`
already does the work; it answers `ScheduleAlreadyExistsError` for an id in
use, which is correct and is the wrong shape for the one place schedules get
registered — a deploy, which runs again on every release. The repair people
reach for is a `try`/ignore, and that hides the failure that matters: a
schedule left on the server with a spec the deploy stopped writing.

Two things it deliberately does not do:

- **It reconciles `spec` and nothing else.** `state` is preserved because a
  schedule an operator paused stays paused across a deploy — unpausing it is a
  decision a person made. `args` and the rest of the action are preserved for a
  different reason: `create` validates args against the workflow's input schema
  and the handle's `update` validates nothing, so writing them here would push
  unvalidated input at the server through a door the typed client keeps shut.
  After the call the schedule FIRES when the arguments say; WHAT it fires with
  is whatever it already fired with, and `schedule.spec.ts` pins that.
- **It recovers exactly one error.** The matcher has no wildcard, so the other
  two arms are named and re-erred, and a fourth error added upstream fails this
  file rather than being silently recovered into a schedule nobody registered.
  Both arms are covered by `schedule.spec.ts`, reached past the types.

Why a subpath rather than a `-client` package, against the naming thesis: that
rule exists because peers are per-package and a caller must not install the
serving half. This is not the calling half of a contract — it starts no
workflow and awaits no result — it is a deployment operation performed by
whoever ships the worker, who already holds this package.
