---
title: "@btravstack/temporal-worker"
description: The Temporal worker starter — TemporalModule, TemporalActivities, TemporalWorkflowActivities, temporal(), its three ports, TemporalUnreachable, WorkflowSource, the unit per activity attempt, and the drain raced against the kernel's deadline.
---

<!-- doctest: prelude
import { TemporalActivities, TemporalModule, TemporalWorkflowActivities } from "@btravstack/temporal-worker";
import { P } from "unthrown";
import { TenantId } from "@btravstack/example-order-domain";
import {
  OrderApplicationModule,
  OrderRepository,
  PaymentService,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { BillingModule } from "../../billing.js";
import { FulfillmentModule } from "../../fulfillment.js";
-->

# @btravstack/temporal-worker

> **Reference.** A complete, structured description of the Temporal worker
> starter's public surface: every export of `@btravstack/temporal-worker`, its
> options and defaults, and how a worker's drain meets the kernel's deadline.
> For the task, see [Run a Temporal worker](/how-to/run-a-temporal-worker);
> for the reasoning, [Starters](/explanation/starters) and
> [Draining, in three beats](/explanation/draining-in-three-beats); for the
> worked example, [Order Temporal worker](/examples/order-temporal-worker).
> Generated signatures are under [API reference](/api/temporal-worker/).

## Exports

`packages/temporal-worker/src/index.ts` exports exactly this:

| Export                           | Kind  | What it is                                                                                                                                                                                                                                                            |
| -------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TemporalModule`                 | value | `TemporalModule(name)({ contract, activities, workflows, address?, namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports?, needs? })` — a di `Module(name)({...})` that also takes the activities provider                                              |
| `TemporalModuleOptions`          | type  | The options object `TemporalModule(name)` takes                                                                                                                                                                                                                       |
| `TemporalActivities`             | value | `TemporalActivities(contract)` — di's `Provider(port)` builder on the starter's own activities port, typed for `contract`, so the next call is `({ name: Dep }, arm)`, or `([pieces])` to compose one provider per workflow                                           |
| `ActivitiesPortOf<C>`            | type  | The activities port's class typed for `C` — what a composed `orderActivities`'s `.port` is                                                                                                                                                                            |
| `ActivitiesInstanceOf<C>`        | type  | That port's instance typed for `C`                                                                                                                                                                                                                                    |
| `TemporalWorkflowActivities`     | value | `TemporalWorkflowActivities(contract, key)` — one workflow's activities (or a contract-global activity) as a provider of its own, typed by `key` alone; the next call is `({ name: Dep }, arm)`, and the piece is what `TemporalActivities(contract)([...])` composes |
| `WorkflowActivitiesPortOf<C, K>` | type  | One piece's port class, typed for the one key `K` it implements                                                                                                                                                                                                       |
| `temporal`                       | value | `temporal({ contract, workflows, … })` — the starter module itself, needing the activities port for `contract`; what `TemporalModule` imports                                                                                                                         |
| `TemporalOptions`                | type  | `temporal()`'s options                                                                                                                                                                                                                                                |
| `TemporalRuntime`                | value | `class TemporalRuntime extends RuntimePort<Runtime<never, TemporalInfo>> {}` — the runtime's port                                                                                                                                                                     |
| `TemporalConfig`                 | value | `class TemporalConfig extends Port("TemporalConfig")<{ address: string; namespace: string }> {}` — where the service is, bound from the environment                                                                                                                   |
| `TemporalConnection`             | value | `class TemporalConnection extends Port("TemporalConnection")<NativeConnection> {}` — the connection, a resource of the graph                                                                                                                                          |
| `TemporalUnreachable`            | value | `TaggedError("TemporalUnreachable")<{ address: string; cause: unknown }>` — the service did not answer                                                                                                                                                                |
| `TemporalInfo`                   | type  | `{ readonly taskQueue: string; readonly namespace: string }` — published on `Serving.info` once polling                                                                                                                                                               |
| `WorkflowSource`                 | type  | `{ workflowsPath: string } \| { workflowBundle: WorkflowBundleWithSourceMap }` — where the sandbox's code comes from                                                                                                                                                  |

`ActivitiesPortOf<C>` / `ActivitiesInstanceOf<C>` / `WorkflowActivitiesPortOf<C,
K>` are exported as **types only**, and only because declaration emit forces
it: an application that composes `orderActivities =
TemporalActivities(contract)([piece, piece])` and exports it by name (or a
slice that exports one piece by name) needs to be able to print that type,
and a type built from an unexported alias fails TS4023 ("has or is using
name 'ID' … but cannot be named") the moment it tries. `TemporalActivitiesPort`
— `Port("TemporalActivities")`, the starter's own activities port, declared
once — and `ActivitiesOf<C>` (`DeclareActivitiesHandlerOptions<C>["activities"]`,
the implementations record `declareActivitiesHandler` takes, its service)
live in `src/temporal-runtime.ts` and stay **not** exported from the entry
point: nothing outside this package legitimately constructs a provider
against the bare port — a consumer always goes through
`TemporalActivities(contract)` or `TemporalWorkflowActivities(contract,
key)`, both of which cast it to the typed alias — so there is nothing a
value export would help with, and the port is reached as `provider.port`
when a caller needs it, with the types inferred at the call. `ActivitiesKeyOf<C>`
and `WORKFLOW_ACTIVITIES_PREFIX` (`src/workflow-activities.ts`) are
unexported on the same terms — a bare key nothing outside that file needs to
name, and the string prefix a piece's port id carries.

## `TemporalModule(name)({...})`

Everything `Module(name)({...})` takes, plus the contract, the activities
provider and the workflow source. It appends
`temporal({ contract, workflows, … })` to
`imports`, prepends `activities` to `provides`, prepends `TemporalRuntime` to
`exports`, and hands the augmented tuples to di's own `Module(name)`.

| Option        | Required | Default                              | What it is                                                                                                                                                                                                           |
| ------------- | -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`    | yes      | —                                    | a `temporal-contract` `ContractDefinition`; the task queue this worker polls is read off it                                                                                                                          |
| `activities`  | yes      | —                                    | the activities **provider** — a `Provider<ActivitiesInstanceOf<C>, E, N>`, what `TemporalActivities(contract)({ name: Dep }, arm)` returns for **this** `contract`; one built for another contract fails at the call |
| `workflows`   | yes      | —                                    | a `WorkflowSource`                                                                                                                                                                                                   |
| `address`     | no       | read from `TEMPORAL_ADDRESS`         | pins `TemporalConfig.address`                                                                                                                                                                                        |
| `namespace`   | no       | read from `TEMPORAL_NAMESPACE`       | pins `TemporalConfig.namespace`                                                                                                                                                                                      |
| `gracePeriod` | no       | read from `TEMPORAL_GRACE_PERIOD_MS` | pins Temporal's `shutdownGraceTime`, a `Duration` (default `10_000` ms)                                                                                                                                              |
| `forceAfter`  | no       | read from `TEMPORAL_FORCE_AFTER_MS`  | pins Temporal's `shutdownForceTime`, a `Duration` (default `15_000` ms); keep it at or below the kernel's `drainTimeoutMs`                                                                                           |
| `imports`     | no       | `[]`                                 | the application's modules                                                                                                                                                                                            |
| `provides`    | no       | `[]`                                 | the application's own providers                                                                                                                                                                                      |
| `exports`     | no       | `[]`                                 | the application's own exports; `TemporalRuntime` is added                                                                                                                                                            |

The worked composition root, from
`examples/order-temporal-worker/src/module.ts`:

<!-- doctest: group=order-temporal-worker -->
<!-- doctest: defer -->

```ts
export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
  contract: orderContract,
  activities: orderActivities,
  workflows: {
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  },
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    FulfillmentModule,
    BillingModule,
  ],
});
```

## `TemporalActivities(contract)`

The first call fixes `C` (the contract value is otherwise unused; it exists so
`C` is inferred rather than written) and returns `ReturnType<typeof
Provider<ActivitiesPortOf<C>>>` — di's own `Provider(port)` builder on the
starter's activities port, typed for `C` — so the second call is di's `(deps,
arm)` unchanged: any arm, the usual typing, and the provider it returns carries
the port typed as `provider.port`. There is no name to give: a worker serves
one activities record as it polls one task queue, so the port is the starter's
— one `Port("TemporalActivities")`, generic at the value level and fixed per
contract at the type level (`ActivitiesPortOf<C>`, the move the kernel's
`RuntimePort` makes) — and two activities providers in one graph are di's
duplicate-provider defect at build. Each activity is a plain function typed by
the contract (`(args, { errors }) => AsyncResult<…>`), closing over the
services the provider declared; nothing is read from a context.

Expanded, the monolithic form looks like this — not a call site inside
`examples/order-temporal-worker` any more, since `orderContract` now declares
**two** workflows and its own worker composes this record from two pieces
instead (see the composing form below and
[Split a worker into slices](/how-to/split-a-worker-into-slices)), but the
form itself is unchanged and still what [Run a Temporal
worker](/how-to/run-a-temporal-worker) teaches for a worker with one saga. A
single record covers **every** workflow the contract declares, so this one
carries `chargeOrder` too, not `fulfillOrder` alone:

```ts
export const orderActivities = TemporalActivities(orderContract)(
  {
    place: PlaceOrder,
    repository: OrderRepository,
    stock: StockService,
    shipping: ShippingService,
    payments: PaymentService,
  },
  {
    sync: ({ place, repository, stock, shipping, payments }) => ({
      fulfillOrder: {
        place: (args, { errors }) =>
          place
            .execute(TenantId(args.tenantId), args.orderId, args.quantity)
            .map((order) => ({ id: order.id, quantity: order.quantity }))
            .mapErrCases((matcher) =>
              matcher
                .with(P.tag("InvalidQuantity"), (error) =>
                  errors.InvalidQuantity({ id: error.id }),
                )
                .with(P.tag("InvalidOrderId"), (error) =>
                  errors.InvalidOrderId({ id: error.id }),
                )
                .with(P.tag("DuplicateOrder"), (error) =>
                  errors.OrderAlreadyPlaced({ id: error.id }),
                ),
            ),
        reserveStock: (args, { errors }) =>
          stock
            .reserve(args.orderId, args.quantity)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("OutOfStock"), (error) =>
                errors.OutOfStock({ id: error.id }),
              ),
            ),
        arrangeShipping: (args, { errors }) =>
          shipping
            .arrange(args.orderId)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("ShippingUnavailable"), (error) =>
                errors.ShippingUnavailable({ id: error.id }),
              ),
            ),
        releaseStock: (args) => stock.release(args.orderId),
        cancelPlacement: (args) =>
          repository
            .remove(TenantId(args.tenantId), args.orderId)
            .recoverErrCases((matcher) =>
              matcher.with(P.tag("OrderNotFound"), () => undefined),
            ),
      },
      chargeOrder: {
        authorizePayment: (args, { errors }) =>
          payments
            .authorize(args.orderId, args.amount)
            .map((authorizationId) => ({ authorizationId }))
            .mapErrCases((matcher) =>
              matcher.with(P.tag("PaymentDeclined"), (error) =>
                errors.PaymentDeclined({ id: error.id }),
              ),
            ),
        capturePayment: (args) => payments.capture(args.authorizationId),
        refundPayment: (args) => payments.refund(args.authorizationId),
      },
    }),
  },
);
```

One record, one `sync`, both sagas' services in its `deps` — which is exactly
the shape that stops scaling once a worker owns enough workflows, and why the
composing form below exists.

`args.tenantId` is the application's, not the package's: it is a field the
**contract** declares on every workflow and activity input, which is what
makes it survive a replay — Temporal persists an activity's input in the
event history. `@btravstack/temporal-worker` reads nothing about tenancy.
`TenantId(…)` is `examples/order-domain`'s brand claimed at the boundary the
activity is, so a use case cannot be handed an order id where a tenant goes;
the contract validated the field as a UUIDv7 before the activity was entered,
so the constructor casts rather than parses.

A hand-written `Provider(orderActivities.port)(…)` targets the same port; a
port declared under any other id leaves the starter's need unmet, and `start`
refuses the module.

A third call composes several **pieces** instead of one record:
`TemporalActivities(contract)([piece, piece, ...])`, where each piece is what
`TemporalWorkflowActivities(contract, key)({ name: Dep }, arm)` returns. Di
constructs every piece first — they are the composed provider's own `deps`,
declared under the very key each piece's port id carries, so the services
record IS the activities record. Every top-level key the contract's
activities record declares must be covered: an array missing one is refused
at the call, against an
`"UNCOVERED ACTIVITIES — the contract declares a workflow this array does not cover"`
marker. The diagnostic is a three-line `TS2769` and the sentence is at the
**tail of the third line**, past three hundred characters of the caller's own
contract type — measured, and not shortenable from inside this package. The
missing key itself is named too once the array's length matches that marker
tuple's own length of 2: TypeScript then matches the array against the tuple
positionally and reports the trailing element separately — measured against
this example's two-workflow contract, `is not assignable to type
'"fulfillOrder"'`: the bare key, not the marker tuple. A single-element array's
diagnostic names the marker alone; a piece built for another contract is refused
too, structurally, since its port's service is
that contract's activities for the key. `Uncovered` checks coverage, not
injectivity, so two pieces claiming the same key still type-check together;
di's duplicate-provider defect at build catches it only once **both** end up
discharged as providers in the same graph — wire in just one and the other is
silently unregistered, with no diagnostic. The composed
provider's own `deps` are the **pieces' ports**, not what a piece closes
over, so the pieces themselves still need discharging like any other need —
typically `provides: [...]` on the module, or a slice module that exports its
own piece.

## `TemporalWorkflowActivities(contract, key)`

One workflow's activities, or a contract-global activity, as a provider of
its own: the port id carries the top-level key
(`` `TemporalWorkflowActivities:${key}` ``, `WORKFLOW_ACTIVITIES_PREFIX`
stripped by the composing form to recover it), so two slices claiming one
workflow is di's duplicate-provider defect rather than a silent merge.
`contract` types `key` (any top-level key of `ActivitiesOf<C>` — a workflow
that declares activities, or a contract-global activity, so the name is
imprecise in the latter case, deliberately: narrowing the type to workflow
keys only would cost extra type code and lock a contract with global
activities out of the split) and the piece; a key the contract does not
declare is refused at the call — there is nothing to type it by — and an
activity whose input has drifted is a compile error here rather than at
startup. There is no name to give and nothing minted by hand: the return is
di's own `Provider(port)`, so every arm is available exactly as it is on
`TemporalActivities(contract)`, and the provider carries its port as
`provider.port` (`WorkflowActivitiesPortOf<C, K>`).

<!-- doctest: skip — elides all but one activity per piece; the full pieces are compiled by docs/examples/order-temporal-worker.md -->

```ts
const orderFulfillment = TemporalWorkflowActivities(
  orderContract,
  "fulfillOrder",
)(
  {
    place: PlaceOrder,
    repository: OrderRepository,
    stock: StockService,
    shipping: ShippingService,
  },
  {
    sync: ({ place, repository, stock, shipping }) => ({
      place: (args, { errors }) =>
        place
          .execute(TenantId(args.tenantId), args.orderId, args.quantity)
          .map((order) => ({ id: order.id, quantity: order.quantity }))
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.InvalidQuantity({ id: error.id }),
              )
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.InvalidOrderId({ id: error.id }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.OrderAlreadyPlaced({ id: error.id }),
              ),
          ),
      // … the rest of the record, one arm per activity `fulfillOrder` declares
    }),
  },
);

const orderBilling = TemporalWorkflowActivities(orderContract, "chargeOrder")(
  { payments: PaymentService },
  {
    sync: ({ payments }) => ({
      authorizePayment: (args, { errors }) =>
        payments
          .authorize(args.orderId, args.amount)
          .map((authorizationId) => ({ authorizationId }))
          .mapErrCases((matcher) =>
            matcher.with(P.tag("PaymentDeclined"), (error) =>
              errors.PaymentDeclined({ id: error.id }),
            ),
          ),
      // … the rest of the record, one arm per activity `chargeOrder` declares
    }),
  },
);

// orderContract declares both workflows, so the composing call must cover
// both — one piece short and it is refused at the call.
const orderActivities = TemporalActivities(orderContract)([
  orderFulfillment,
  orderBilling,
]);
```

## `temporal(options)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
const temporal: <C extends ContractDefinition>(
  options: TemporalOptions<C>,
) => Module<
  TemporalRuntime | TemporalConfig | TemporalConnection,
  ConfigInvalid | TemporalUnreachable,
  Env | Scope | ActivitiesInstanceOf<C>
>;
```

The primitive `TemporalModule` delegates to. `TemporalOptions<C>` has the
same fields as the sugar minus `activities` / `imports` / `provides` /
`exports`: the activities are not an option but the module's need. It
provides and exports all three ports, and **needs** `Env` (the kernel
discharges it), `Scope` (the connection is a resource; `start` discharges it
too) and the activities port typed for `contract` (`ActivitiesInstanceOf<C>`)
— the runtime provider depends on it through di, so a root that does not
provide it, or provides one built for another contract, is refused at
`start`.

The declared type is the same pinned or not: `Env`, `ConfigInvalid` and
`TemporalUnreachable` stay in the signature whatever is pinned.

## `TemporalConfig`, and the environment

Bound through [`Config.provider`](/reference/config); every option pins its
field — explicit > environment > default, per field.

| Variable                   | Default          | Parsed by        | Notes                                                                  |
| -------------------------- | ---------------- | ---------------- | ---------------------------------------------------------------------- |
| `TEMPORAL_ADDRESS`         | `127.0.0.1:7233` | `Config.string`  | where the service is                                                   |
| `TEMPORAL_NAMESPACE`       | `default`        | `Config.string`  | a blank value is a `ConfigInvalid`, not a default                      |
| `TEMPORAL_GRACE_PERIOD_MS` | `10000`          | `Config.integer` | Temporal's `shutdownGraceTime`                                         |
| `TEMPORAL_FORCE_AFTER_MS`  | `15000`          | `Config.integer` | Temporal's `shutdownForceTime`; keep it at or below `DRAIN_TIMEOUT_MS` |

`TemporalConfig` holds the two shutdown budgets as **milliseconds**: an
environment carries strings, and a `gracePeriod: "10 seconds"` pin is turned
into the same number by Temporal's own `msToNumber`, so both routes reach the
worker identically.

A malformed value is a `ConfigInvalid` — `startFailed` and exit `78` under
`runMain`.

## `TemporalConnection` and `TemporalUnreachable`

The `NativeConnection` is a **resourceful** provider from `[TemporalConfig]`:
acquired with the scope (`NativeConnection.connect({ address })`) and released
on every exit path, startup failure included. A service that will not answer
is the modeled `TemporalUnreachable { address, cause }` — exit `1` under
`runMain`, a startup `Err` an operator can act on, not the `70` a defect earns.

On release, one refusal is absorbed: `close()` throws `IllegalStateError`
while a Worker still holds the connection, which is exactly the state the
deadline path leaves it in (see the drain below); any other close failure is
still the finaliser's to surface as a `teardownError`.

## `TemporalRuntime` and `TemporalInfo`

Declared over the kernel's `RuntimePort` with service
`Runtime<never, TemporalInfo>` — it resolves nothing. Its `start` calls
`declareActivitiesHandler` **inside** the qualified chain (a contract it
cannot satisfy — an undeclared implementation, a declared one missing —
throws there, and that throw becomes `Err(RuntimeStartFailed({ runtime:
"temporal", cause }))`, exit `1`, not a defect), then `Worker.create` with the
connection, `namespace`, `taskQueue`, the workflow source, the wrapped
activities, `shutdownGraceTime` and `shutdownForceTime`. Once `run()` has
started polling it publishes `TemporalInfo`, `{ taskQueue, namespace }`, on
`Serving.info`.

## Sequencing a saga: `flatTap`, never sibling `const`s

An `AsyncResult` is **eager** — constructing it starts the work. So the
readable spelling of a sequence, each step in its own `const` and then chained,
is a **race**: it type-checks, it returns a `Result`, and it runs the steps
concurrently. Nothing catches it.

Sequence with [`flatTap`](https://github.com/btravstack/unthrown) instead. It
runs a failable step, discards its value and passes the **original** one
through, so the next step is a callback that cannot start before the previous
settles — and each step's error triage and compensation stay at one level of
indentation rather than accumulating:

<!-- doctest: skip — a saga excerpt with elided arms; the full workflow is compiled by docs/examples/order-temporal-worker.md -->

```ts
context.activities
  .place(order)
  .mapErrCases(/* triage */)
  .flatTap(() =>
    context.activities.reserveStock(order).flatMapErrCases(/* compensate */),
  )
  .flatTap(() =>
    context.activities.arrangeShipping(order).flatMapErrCases(/* compensate */),
  );
```

Where a later step needs an earlier step's _value_ rather than just its
success, `DoAsync().bind("name", (scope) => …)` is the same idea with an
accumulating scope. See
[Order Temporal worker](/examples/order-temporal-worker) for both at full size.

## The unit

One unit per activity **attempt**, `kind: "activity"`, opened by the
starter's own `ActivityMiddleware`, which calls `next()` unchanged — it
injects nothing, and the ambient `currentUnit()` record is what an adapter
reads the trace id from, and the **only** route to the unit's `AbortSignal`
from inside an activity: `currentUnit()?.signal`, aborted at the kernel's
`drainTimeoutMs`. Temporal's `Context.current().cancellationSignal` is a
different clock — a workflow-side cancellation, and worker shutdown after
`shutdownGraceTime` — so the two are honoured together.

| `UnitMeta` field | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`             | `activityInfo().base64TaskToken` — identifies one activity task attempt; uniqueness is Temporal's guarantee |
| `traceId`        | the workflow id, falling back to the activity id for an activity with no workflow                           |

A workflow id would be wrong as the `id` twice over: an activity is retried
under the same execution, and Temporal lets a workflow id be reused once an
execution closes. It is the correlation id — stable across every retry — which
is what `traceId` is for.

## The drain, and the deadline

`Serving.drain(signal)` calls `worker.shutdown()` — polling stops at once,
in-flight activities run to completion — then waits on `worker.run()`
**raced against the kernel's deadline `signal`**, and keeps the signal so
`stop()` is released by the same abort. `run()` settles on Temporal's own
`shutdownForceTime`, not the kernel's `drainTimeoutMs`; without the race, an
activity that never finishes would hold `Serving.stop` past the kernel's
deadline.

When the deadline wins, the runtime returns and the worker is still alive.
`@temporalio/worker` exposes no public forced shutdown
(`Worker.forceShutdown$` is `protected`, `Runtime.shutdown()` is
process-global), so stopping the wait is the only escalation: the kernel gets
its thread back on time, reports the activity `abandoned`, and the worker
keeps winding down on Temporal's clock until the process exits. The losing
branch's `Result` is dropped — the kernel has already settled `exited` — and
it is the one drop in the package.

`stop()` with no prior `drain` (the `RunningApp.stop()` path) has no deadline
to race and waits on `run()` alone, which is where `forceAfter` decides when
the process exits. Keep `forceAfter` at or below `drainTimeoutMs`
(default `20_000`); the package cannot enforce that, since a runtime is handed
neither the option nor the clock.

## Peer dependencies

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`,
`@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`,
`@temporal-contract/worker`, `@temporal-contract/contract`. All nine are
peers. Node `>=22`.

## Deliberately not included

- **`Result` → activity failure.** `declareActivitiesHandler` already owns
  it: a declared contract error becomes a `nonRetryable` `ApplicationFailure`
  the workflow branches on, and anything unmodeled is retried by the
  platform's own policy. The starter does not do it a second time.
- **A forced shutdown.** There is no public one to call; the escalation is
  the released wait above.
- **A workflow client.** The starter runs a Worker; starting executions is
  `@temporal-contract/client`'s job.

## Testing

The package's own suite needs a **Docker daemon**: `temporal-runtime.spec.ts`
and `workflow-activities.spec.ts` boot a real `@temporalio/worker` Worker
against a real Temporal server — one `temporalio/auto-setup` container shared
by the whole repository, with a **namespace per spec file** for isolation
(see [Order Temporal worker](/examples/order-temporal-worker) for the same
choice and its measured cost). It replaced a time-skipping test server started
per vitest worker; neither suite ever advanced a clock, so the skippable clock
bought nothing a private namespace does not. `temporal-runtime.spec.ts` carries 13 specs — one
the published info, four the starter's configuration, one the connection, two
the qualified startup chain, two the unit boundary, three the drain;
`workflow-activities.spec.ts`
adds 2 more — a two-workflow, one-task-queue contract composed from two
pieces, pinning that both are mounted and that each was built from the ports
its own provider declared — for 15 total. `workflow-activities.test-d.ts`
pins the composing form's compile-time gates: a piece typed by its own key,
an array covering every declared key composing into what `TemporalModule`
takes, a key the contract does not declare refused at the piece's own call,
an array missing a key refused at the composing call, and a piece built for
another contract refused there too. The two files are deliberate mirrors —
six labelled properties each, three of them negatives — and they drifted apart
once (issue #51). Checked by
`tsc -p tsconfig.test-d.json`, which the package's own `test:types` script
runs and `typecheck` runs alongside the ordinary `tsc --noEmit`.
