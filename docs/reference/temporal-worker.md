---
title: "@btravstack/temporal-worker"
description: The Temporal worker starter — TemporalModule, TemporalActivities, TemporalWorkflowActivities, temporal(), its three ports, TemporalUnreachable, WorkflowSource, the unit per activity attempt, and the drain raced against the kernel's deadline.
---

<!-- doctest: prelude
import {
  TemporalActivities,
  TemporalConfig,
  TemporalConnection,
  TemporalModule,
  TemporalRuntime,
  TemporalUnreachable,
  TemporalWorkflowActivities,
  type ActivitiesInstanceOf,
  type TemporalOptions,
} from "@btravstack/temporal-worker";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { ConfigInvalid, Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
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

| Export                           | Kind  | What it is                                                                                                                                                                                                                                                                              |
| -------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TemporalModule`                 | value | `TemporalModule(name)({ contract, activities, workflows, address?, namespace?, gracePeriod?, forceAfter?, unit?, imports?, provides?, exports?, needs? })` — a di `Module(name)({...})` that also takes the activities provider                                                         |
| `TemporalModuleOptions`          | type  | The options object `TemporalModule(name)` takes                                                                                                                                                                                                                                         |
| `TemporalActivities`             | value | `TemporalActivities(contract)` — the builder on the starter's own activities port, typed for `contract`, so the next call is `{ inject: { name: Dep }, unit?, sync }`, or `([pieces])` to compose one provider per workflow                                                             |
| `ActivitiesPortOf<C>`            | type  | The activities port's class typed for `C` — what a composed `orderActivities`'s `.port` is                                                                                                                                                                                              |
| `ActivitiesInstanceOf<C>`        | type  | That port's instance typed for `C`                                                                                                                                                                                                                                                      |
| `TemporalWorkflowActivities`     | value | `TemporalWorkflowActivities(contract, key)` — one workflow's activities (or a contract-global activity) as a provider of its own, typed by `key` alone; the next call is `{ inject: { name: Dep }, unit?, sync }`, and the piece is what `TemporalActivities(contract)([...])` composes |
| `WorkflowActivitiesPortOf<C, K>` | type  | One piece's port class, typed for the one key `K` it implements                                                                                                                                                                                                                         |
| `ActivityInput`                  | value | `ActivityInput(contract)` — the port the validated invocation is **seeded** on, typed by that contract's own activity inputs; a unit module names it in `needs` and injects it                                                                                                          |
| `ActivityInputOf<C>`             | type  | The union of every activity input `C` declares, workflow-local and contract-global alike — what `ActivityInput(C)` carries                                                                                                                                                              |
| `ActivityInputPortOf<C>`         | type  | `ActivityInput(C)`'s port class, typed for `C`                                                                                                                                                                                                                                          |
| `temporal`                       | value | `temporal({ contract, workflows, … })` — the starter module itself, needing the activities port for `contract`; what `TemporalModule` imports                                                                                                                                           |
| `TemporalOptions`                | type  | `temporal()`'s options                                                                                                                                                                                                                                                                  |
| `TemporalRuntime`                | value | `class TemporalRuntime extends RuntimePort<Runtime<never, TemporalInfo>> {}` — the runtime's port                                                                                                                                                                                       |
| `TemporalConfig`                 | value | `class TemporalConfig extends Port("TemporalConfig")<{ address: string; namespace: string; gracePeriodMs: number; forceAfterMs: number }> {}` — where the service is and what its shutdown budget is, bound from the environment                                                        |
| `TemporalConnection`             | value | `class TemporalConnection extends Port("TemporalConnection")<NativeConnection> {}` — the connection, a resource of the graph                                                                                                                                                            |
| `TemporalUnreachable`            | value | `TaggedError("TemporalUnreachable")<{ address: string; cause: unknown }>` — the service did not answer                                                                                                                                                                                  |
| `TemporalInfo`                   | type  | `{ readonly taskQueue: string; readonly namespace: string }` — published on `Serving.info` once polling                                                                                                                                                                                 |
| `WorkflowSource`                 | type  | `{ workflowsPath: string } \| { workflowBundle: WorkflowBundleWithSourceMap }` — where the sandbox's code comes from                                                                                                                                                                    |

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

| Option        | Required | Default                              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract`    | yes      | —                                    | a `temporal-contract` `ContractDefinition`; the task queue this worker polls is read off it                                                                                                                                                                                                                                                                                                                                                |
| `activities`  | yes      | —                                    | the activities **provider** — a `Provider<ActivitiesInstanceOf<C>, E, N>`, what `TemporalActivities(contract)({ inject: { name: Dep }, unit?, sync })` returns for **this** `contract`; one built for another contract fails at the call                                                                                                                                                                                                   |
| `workflows`   | yes      | —                                    | a `WorkflowSource`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `address`     | no       | read from `TEMPORAL_ADDRESS`         | pins `TemporalConfig.address`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `namespace`   | no       | read from `TEMPORAL_NAMESPACE`       | pins `TemporalConfig.namespace`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gracePeriod` | no       | read from `TEMPORAL_GRACE_PERIOD_MS` | pins Temporal's `shutdownGraceTime`, a `Duration` (default `10_000` ms)                                                                                                                                                                                                                                                                                                                                                                    |
| `forceAfter`  | no       | read from `TEMPORAL_FORCE_AFTER_MS`  | pins Temporal's `shutdownForceTime`, a `Duration` (default `15_000` ms); keep it at or below the kernel's `drainTimeoutMs`                                                                                                                                                                                                                                                                                                                 |
| `unit`        | no       | unset — dispatch runs unchanged      | `{ activity?: Unit }`, the unit module forked around every activity attempt and **seeded with the validated input on `ActivityInput(contract)`** — built after the activity is invoked, before it runs, torn down when the unit closes; a bound module's own unmet needs join this root's (less the seeded port), refused the same way an unmet activities port is. **Gated** against what the pieces declared — see [The unit](#the-unit) |
| `imports`     | no       | `[]`                                 | the application's modules                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provides`    | no       | `[]`                                 | the application's own providers                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exports`     | no       | `[]`                                 | the application's own exports; `TemporalRuntime` is added                                                                                                                                                                                                                                                                                                                                                                                  |

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

### RED metrics, reported always and collected when you ask

The runtime REPORTS rate, errors and duration at the unit seam — the one place a
framework that owns the unit lifecycle gets them for free — and an observer is
what turns a report into a measurement. Reporting always happens; **collection
happens when `otel()` is composed**, and not before:

| Instrument                              | Kind           | Dimensions            |
| --------------------------------------- | -------------- | --------------------- |
| `btravstack.temporal.activity.attempts` | counter        | `activity`, `outcome` |
| `btravstack.temporal.activity.duration` | histogram (ms) | the same two          |

`instrumented` is gone. Every unit is handed to `Observers`, and this module
contributes a no-op member of its own — so a graph composing no observability
owes nothing, and an operation costs one inert call per module that reads the
port. Composing [`observability()`](/reference/observability) writes the
failures as lines; composing `otel()` beside it opens the spans and mints
`btravstack.<component>.operations` and `.duration`.

**The dimensions are chosen for cardinality, and what is absent matters more
than what is present.** Per **attempt**, not per activity: a retried activity records once per attempt, which is what makes the rate readable when a downstream is failing — the workflow's own count would hide exactly the retries worth alerting on. The workflow id is not a dimension and must not be: it is unbounded, and it is already the unit's `traceId`, which is where an unbounded value belongs.

## `TemporalActivities(contract)`

The first call fixes `C` (the contract value is otherwise unused; it exists so
`C` is inferred rather than written) and returns a builder on the
starter's activities port, typed for `C` — so the second call is
`{ inject, unit?, sync }`, whose `sync` hands back the whole activities record,
and the provider it returns carries the port typed as `provider.port`. It is
`{ inject, unit?, sync }` rather than di's whole arm set for **parity**:
`api.OrpcRouter(contract)` and all three packages' piece factories spell it
that way, so one arm across the family is one surface to learn and one to keep.
`unit` declares the ports **every** entry of the record reads off
`context.unit`, resolved out of the per-attempt fork exactly as a piece's are
and gated by `TemporalModule` the same way — so a worker that has not outgrown
one function needs no slicing to reach it. There is no name to give: a worker serves
one activities record as it polls one task queue, so the port is the starter's
— one `Port("TemporalActivities")`, generic at the value level and fixed per
contract at the type level (`ActivitiesPortOf<C>`, the move the kernel's
`RuntimePort` makes) — and two activities providers in one graph are di's
duplicate-provider defect at build. Each activity is a plain function typed by
the contract (`({ errors, input }) => AsyncResult<…>`), closing over the
services the provider declared; the record it receives carries the invocation's
own values — the validated `input` and the contract's `errors` — and no service
is resolved at call time.

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
export const orderActivities = TemporalActivities(orderContract)({
  inject: {
    place: PlaceOrder,
    repository: OrderRepository,
    stock: StockService,
    shipping: ShippingService,
    payments: PaymentService,
  },
  sync: ({ place, repository, stock, shipping, payments }) => ({
    fulfillOrder: {
      place: ({ errors, input }) =>
        place
          .execute(TenantId(input.tenantId), input.orderId, input.quantity)
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
      reserveStock: ({ errors, input }) =>
        stock
          .reserve(input.orderId, input.quantity)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OutOfStock"), (error) =>
              errors.OutOfStock({ id: error.id }),
            ),
          ),
      arrangeShipping: ({ errors, input }) =>
        shipping
          .arrange(input.orderId)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("ShippingUnavailable"), (error) =>
              errors.ShippingUnavailable({ id: error.id }),
            ),
          ),
      releaseStock: ({ input }) => stock.release(input.orderId),
      cancelPlacement: ({ input }) =>
        repository
          .remove(TenantId(input.tenantId), input.orderId)
          .recoverErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), () => undefined),
          ),
    },
    chargeOrder: {
      authorizePayment: ({ errors, idempotencyKey, input }) =>
        payments
          .authorize(input.orderId, input.amount, idempotencyKey)
          .map((authorizationId) => ({ authorizationId }))
          .mapErrCases((matcher) =>
            matcher.with(P.tag("PaymentDeclined"), (error) =>
              errors.PaymentDeclined({ id: error.id }),
            ),
          ),
      capturePayment: ({ idempotencyKey, input }) =>
        payments.capture(input.authorizationId, idempotencyKey),
      refundPayment: ({ idempotencyKey, input }) =>
        payments.refund(input.authorizationId, idempotencyKey),
    },
  }),
});
```

One record, one `sync`, both sagas' services in its `inject` — which is exactly
the shape that stops scaling once a worker owns enough workflows, and why the
composing form below exists.

`input.tenantId` is the application's, not the package's: it is a field the
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
`TemporalWorkflowActivities(contract, key)({ inject: { name: Dep }, unit?, sync })` returns. Di
constructs every piece first — they are the composed provider's own `deps`,
declared under the very key each piece's port id carries, so the services
record IS the activities record. Every top-level key the contract's
activities record declares must be covered: an array missing one is refused
at the call, against an
`"UNCOVERED ACTIVITIES — the contract declares a workflow this array does not cover"`
marker. The diagnostic is a three-line `TS2769` and the sentence is at the
**tail of the third line**, past three hundred characters of the caller's own
contract type — measured, and not shortenable from inside this package. The
missing key is named beside it, whatever the array's length: the refusal is a
tuple as long as the array you wrote, so TypeScript lines the two up element by
element and reports one error on the trailing element — measured on a
one-element array, `is not assignable to type 'readonly ["UNCOVERED ACTIVITIES
— …", "audit" | "runShout"]'`. A piece built for another contract is refused
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
startup. There is no name to give and nothing minted by hand: the provider
carries its port as `provider.port` (`WorkflowActivitiesPortOf<C, K>`).

The options are `{ inject, unit?, sync }` — this package's own record, not
di's whole arm set. `unit` names the ports the activities read off
`context.unit`, and `sync`'s return is typed by that record while the port it
lands on keeps the context-free shape `declareActivitiesHandler` takes. The
narrowing is for consistency with `@btravstack/http-server`'s `OrpcController`
and `@btravstack/amqp-worker`'s `AmqpHandler` — one arm across the three
transports. A piece with no services is
`{ inject: {}, sync: () => activities }`; the record is put on the leaves by a
wrapper on the piece rather than by the middleware, so it reaches inside both
entry shapes — a workflow key carrying a record of implementations, and a
contract-global key carrying the implementation itself.

<!-- doctest: skip — elides all but one activity per piece; the full pieces are compiled by docs/examples/order-temporal-worker.md -->

```ts
const orderFulfillment = TemporalWorkflowActivities(
  orderContract,
  "fulfillOrder",
)({
  inject: {
    place: PlaceOrder,
    repository: OrderRepository,
    stock: StockService,
    shipping: ShippingService,
  },
  sync: ({ place, repository, stock, shipping }) => ({
    place: ({ errors, input }) =>
      place
        .execute(TenantId(input.tenantId), input.orderId, input.quantity)
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
});

const orderBilling = TemporalWorkflowActivities(
  orderContract,
  "chargeOrder",
)({
  inject: { payments: PaymentService },
  sync: ({ payments }) => ({
    authorizePayment: ({ errors, idempotencyKey, input }) =>
      payments
        .authorize(input.orderId, input.amount, idempotencyKey)
        .map((authorizationId) => ({ authorizationId }))
        .mapErrCases((matcher) =>
          matcher.with(P.tag("PaymentDeclined"), (error) =>
            errors.PaymentDeclined({ id: error.id }),
          ),
        ),
    // … the rest of the record, one arm per activity `chargeOrder` declares
  }),
});

// orderContract declares both workflows, so the composing call must cover
// both — one piece short and it is refused at the call.
const orderActivities = TemporalActivities(orderContract)([
  orderFulfillment,
  orderBilling,
]);
```

## `temporal(options)`

<!-- doctest: skip — the quoted signature names `AnyUnitModule` and `UnitNeedsOf`, which this package declares for its own `Unit` type parameter and does not re-export, so there is nothing a signature check could name them by -->

```ts
const temporal: <C extends ContractDefinition, Unit extends AnyUnitModule | undefined = undefined>(
  options: TemporalOptions<C, Unit>,
) => Module<
  TemporalRuntime | TemporalConfig | TemporalConnection,
  ConfigInvalid | TemporalUnreachable,
  Env | Scope | ActivitiesInstanceOf<C> | UnitNeedsOf<Unit>
>;
```

The primitive `TemporalModule` delegates to. `TemporalOptions<C, Unit>` has the
same fields as the sugar minus `activities` / `imports` / `provides` /
`exports`: the activities are not an option but the module's need. It
provides and exports all three ports, and **needs** `Env` (the kernel
discharges it), `Scope` (the connection is a resource; `start` discharges it
too), the activities port typed for
`contract` (`ActivitiesInstanceOf<C>`)
— the runtime provider depends on it through di, so a root that does not
provide it, or provides one built for another contract, is refused at
`start` — and a bound `unit.activity` module's own unmet needs
(`UnitNeedsOf<Unit>`).

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

## Sequencing a saga: `context.saga()`, never sibling `const`s

An `AsyncResult` is **eager** — constructing it starts the work. So the
readable spelling of a sequence, each step in its own `const` and then chained,
is a **race**: it type-checks, it returns a `Result`, and it runs the steps
concurrently. Nothing catches it.

Where the steps carry compensations, `context.saga()` is the answer. Every
argument is a **thunk**, so nothing is built before the saga reaches it, and
the undos are its own business rather than each step's:

<!-- doctest: skip — a saga excerpt with elided arms; the full workflow is compiled by docs/examples/order-temporal-worker.md -->

```ts
context
  .saga()
  .step(
    () => context.activities.place(order),
    () => context.activities.cancelPlacement(order),
  )
  .step(
    () => context.activities.reserveStock(order),
    () => context.activities.releaseStock(order),
  )
  .step(() => context.activities.arrangeShipping(order))
  .run()
  .mapErrCases(/* one triage, at the end */);
```

`context.saga()` runs the undos **LIFO** and decides which failures earn one: a
declared contract error compensates, an activity that failed unmodelled or was
cancelled does not — a step that died mid-flight left state nobody can see. So
the machinery-tag arm every step used to repeat is gone, and the re-mint
against `context.errors` happens once.

A sequence with **no** compensations does not need a saga:
[`flatTap`](https://github.com/btravstack/unthrown) runs a failable step,
discards its value and passes the **original** one through, so the next step is
a callback that cannot start before the previous settles. Where a later step
needs an earlier step's _value_ rather than just its success,
`DoAsync().bind("name", (scope) => …)` is the same idea with an accumulating
scope. See [Order Temporal worker](/examples/order-temporal-worker) for all
three at full size.

## The unit

One unit per activity **attempt**, `kind: "activity"`, opened by the
starter's own `ActivityMiddleware`. With no `unit` bound it calls `next()`
unchanged, and `context.unit` is `{}` on every piece. With one bound, the
middleware forks it —
after the activity is invoked, before it runs — and tears the fork down when
the unit closes. Either way,
the ambient `currentUnit()` record is what an adapter
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

### `ActivityInput(contract)` — the one seeded port

The fork is seeded with the **validated input**, on `ActivityInput(contract)`.
That is the only entry the worker seeds, and it is what lets a unit module
derive a tenant — or anything else it scopes by — from the invocation rather
than from an ambient record:

<!-- doctest: isolate
import { ActivityInput } from "@btravstack/temporal-worker";
import { Module, Port, Provider } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-temporal-contract";
class Tenant extends Port("Tenant")<string> {}
-->

```ts
const Input = ActivityInput(orderContract);

export const ActivityUnit = Module("ActivityUnit")({
  needs: [Input],
  provides: [
    Provider(Tenant)({
      inject: { input: Input },
      sync: ({ input }) => input.tenantId,
    }),
  ],
  exports: [Tenant],
});
```

One `Port("ActivityInput")` call, cast per contract at the type level, so no
contract instantiating it warns about a duplicate id while a module built for
one contract still cannot read another's input. A module naming that port in
`needs` **owes the composition root nothing for it** — the seed discharges it,
and it is subtracted from what `unit` contributes to the starter's `Needs`;
everything else the module needs still surfaces at `start`.

### `context.unit`, and the gate on the module bound

A piece declares the unit-scoped ports its activities may read as `unit:`
beside `inject`, and an activity reads them off `context.unit.name`. The
whole-record arm takes the same `unit:`, applied to **every** entry of the
record it hands back, so a worker that has not outgrown one function reaches
`context.unit` without slicing first. Entries
are lazy getters over the forked context — neither writable nor configurable,
so an activity reads what the fork holds and cannot reshape the record under
the next attempt.

That declaration is a promise the **root** has to keep, and nothing else checks
it: the piece and the root are typed independently. So `TemporalModule`
**gates** `unit.activity` against what was declared — the union of every
piece's record, collected by `TemporalActivities(contract)([...])` where the
pieces are known, or the record arm's own `unit:` where the worker is one
function — and a bound module that does not export a declared port is refused
against a
`"UNIT DOES NOT PROVIDE — a piece injects a port the bound unit module does not export"`
marker, carrying the offending port. The gate rides the **whole options
record**, not the `unit` property, because a gate on a property is not read
when the property is absent — and a root that declares a piece's `unit:` and
then binds no module at all is exactly the case worth catching.

**`temporal()` is not gated**, structurally: it takes its activities as a
**need**, never as a value, so there is nothing to read the declarations off.
That is the one path where a declared port goes unchecked, and it fails two
ways. With no module bound the record is empty, so `context.unit.tenant` is
`undefined` and the next property access throws a `TypeError`; with a module
bound that does not export `Tenant`, the getter runs and di throws
`[di] no service registered for port …`, naming the port. Either way it is a
throw out of the activity body — and a synchronous one never reaches
`declareActivitiesHandler`'s `defect` arm at all, since the implementation is
called inside the wrapped activity's own `async` function. The outcome is the
arm's own: Temporal fails the attempt with the raw error rather than a modeled
`ApplicationFailure`, and the contract's retry policy decides whether it comes
back. Loud, on the first attempt, never a silent wrong answer.

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
