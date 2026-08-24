---
title: Order Temporal worker example
description: The orchestration deployment — two saga slices, FulfillmentSlice and BillingSlice, composed by TemporalActivities over one task queue, a chargeOrder saga compensating with a refund, mapErrCases making a domain Err a nonRetryable contract error, a namespace per spec file on the shared Temporal server, and a drain that honours the kernel's deadline.
---

<!-- doctest: prelude
import { TemporalActivities, TemporalModule, TemporalWorkflowActivities } from "@btravstack/temporal";
import { P } from "unthrown";
import { observability } from "@btravstack/observability";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { PaymentService } from "@btravstack/example-order-application";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { piece as fulfillOrder } from "../../slices/fulfillment/activities.js";
import { slice as FulfillmentSlice } from "../../slices/fulfillment/module.js";
import { slice as BillingSlice } from "../../slices/billing/module.js";
-->

# Order Temporal worker

[`examples/order-temporal-worker`](https://github.com/btravstack/start/tree/main/examples/order-temporal-worker)
— the orchestration deployment: [the order application](/examples/order-application)
owning two journeys, served by [`@btravstack/temporal`](/reference/temporal).

```sh
pnpm turbo run test --filter=@btravstack/example-order-temporal-worker
```

::: warning Needs Docker
The suite runs a real `@temporalio/worker` Worker against a real Temporal
server — **one `temporalio/auto-setup` container shared by the whole
repository** (`internal/test-infra`), with a **namespace of this spec file's
own** on it, and the example's own PostgreSQL database on the same server it
uses. Nothing is started per workspace and nothing is cleaned up between
tests: the namespace isolates the file, a per-test task queue isolates the
tests inside it, and a per-test **tenant** isolates their rows.

It replaced Temporal's time-skipping test server, a 64 MB local binary started
per vitest worker. Nothing here ever advanced a clock, so the skippable clock
bought nothing a private namespace does not — and the example stopped being
the one that needs the **network** on a cold cache.
:::

## Two sagas, two verticals, one queue

`order-temporal-contract` declares two workflows on the one `orders` task
queue: `fulfillOrder`, the orders saga this example started with, and
`chargeOrder`, a second saga — a second **vertical**, since taking the money
is not part of placing, reserving or shipping the order. This worker is a
modulith of two slices, `src/slices/fulfillment/` and `src/slices/billing/`,
one per workflow — the same shape [`order-api`](/examples/order-api)'s HTTP
controllers use, but with a property `order-amqp-worker`'s two subscriber
slices deliberately do **not** have: each slice here owns a genuinely
different vertical. `FulfillmentSlice` imports the orders vertical
(`OrderApplicationModule` + `OrderPersistenceModule`) plus `FulfillmentModule`;
`BillingSlice` imports `BillingModule` alone. `PlaceOrder` is as invisible
inside `BillingSlice` as `PaymentService` is inside `FulfillmentSlice` — the
two verticals meet only at the root, in the list of slices, never inside
either slice's own graph.

`TemporalWorkflowActivities(contract, key)` mints one piece per workflow — no
port class, no name, since the contract key IS the port's name — and the piece
is typed by the ONE workflow it implements: an activity the workflow does not
declare is a compile error in that slice's own file, not a defect
`declareActivitiesHandler` reports at startup.

<!-- doctest: group=order-temporal-worker -->

```ts
export const chargeOrder = TemporalWorkflowActivities(
  orderContract,
  "chargeOrder",
)(
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
      capturePayment: (args) => payments.capture(args.authorizationId),
      refundPayment: (args) => payments.refund(args.authorizationId),
    }),
  },
);
```

`fulfillOrder`'s own piece is the same activities record this example always
had, moved into `src/slices/fulfillment/activities.ts` unchanged and typed by
its own key. The root composes both pieces into the one record the starter
needs, keyed by the contract's own workflow names:

```ts
export const orderActivities = TemporalActivities(orderContract)([
  fulfillOrder,
  chargeOrder,
]);

export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
  contract: orderContract,
  activities: orderActivities,
  workflows: {
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  },
  imports: [FulfillmentSlice, BillingSlice, observability()],
});
```

A wiring rule worth stating because it fails at runtime, not at compile time:
`orderActivities`'s own `deps` are the two pieces' **ports**, and di's
`flatten` discovers providers only from a module's `imports` and `provides` —
never from a provider's own `deps`. The root **must** import both
`FulfillmentSlice` and `BillingSlice`, even though nothing in it names
`fulfillOrder` or `chargeOrder` directly; dropping either import leaves that
piece's port unmet, and `start` fails with a `WiringDefect` naming it — not a
compile error.

## The fulfillment saga

Three forward steps, each an activity calling into the application layer, and
two compensations the workflow runs **in reverse order of the steps they
undo**:

```
place ──▶ reserveStock ──▶ arrangeShipping ──▶ done
  ▲             ▲ OutOfStock?                 ▲ ShippingUnavailable?
  │             └── cancelPlacement            └── releaseStock, then cancelPlacement
```

The triage rule per step: a **declared** error is a permanent domain answer —
compensate, then re-mint it against `context.errors` so the client branches on
it by name. Temporal's own machinery tags (an activity that exhausted its
retries unmodeled, or was cancelled) are handed back as-is and re-raised by
`propagateActivityFailure`, and compensation deliberately does **not** run for
them, since a step that died mid-flight left unknown state.

The compensations declare no errors: compensation is the saga un-deciding, and
a step that could answer "no" would leave it stuck half-done.
`cancelPlacement` absorbs `OrderNotFound` on purpose — undoing a placement
that never landed is the no-op a **repeated** compensation performs, and an
activity Temporal may re-run has to answer the same both times.

## The billing saga

The smallest saga in the example that still has a compensation:

```
authorizePayment ──▶ capturePayment ──▶ done
                          │ activity failure?
                          └── refundPayment
```

<!-- doctest: isolate
import { orderContract } from "@btravstack/example-order-temporal-contract";
import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  declareWorkflow,
  propagateActivityFailure,
} from "@temporal-contract/worker/workflow";
import { ErrAsync, P } from "unthrown";
-->

```ts
export const chargeOrder = declareWorkflow({
  workflowName: "chargeOrder",
  contract: orderContract,
  implementation: (context, args) =>
    propagateActivityFailure(
      context.activities
        .authorizePayment({
          tenantId: args.tenantId,
          orderId: args.orderId,
          amount: args.amount,
        })
        .mapErrCases((matcher) =>
          matcher
            .with({ errorName: "PaymentDeclined" }, (error) =>
              context.errors.PaymentDeclined({ id: error.data.id }),
            )
            .with(
              P.tag(ACTIVITY_ERROR_TAG),
              P.tag(ACTIVITY_CANCELLED_ERROR_TAG),
              (error) => error,
            ),
        )
        .flatTap((authorized) =>
          context.activities
            .capturePayment({
              tenantId: args.tenantId,
              authorizationId: authorized.authorizationId,
            })
            .flatMapErrCases((matcher) =>
              matcher.with(
                P.tag(ACTIVITY_ERROR_TAG),
                P.tag(ACTIVITY_CANCELLED_ERROR_TAG),
                (error) =>
                  context.activities
                    .refundPayment({
                      tenantId: args.tenantId,
                      authorizationId: authorized.authorizationId,
                    })
                    .flatMap(() => ErrAsync(error)),
              ),
            ),
        ),
    ),
});
```

`authorizePayment`'s `PaymentDeclined` is declared `nonRetryable` in the
contract — a refused card is a permanent answer, and asking Temporal to try
four more times is the bug that discipline prevents. `refundPayment` declares
no errors at all, for the same reason `releaseStock` does: un-deciding must
not be able to answer no. The compensation only runs on an activity failure —
a machinery tag, not a declared one — because `capturePayment` has no declared
error of its own to compensate for; anything it fails with is infrastructure,
which is exactly when the money needs to go back.

## One subtlety worth stealing

An `AsyncResult` is **eager**: building a step starts its activity. So a
sequence must never construct two steps as siblings — hoist them into `const`s
and the "sequence" runs as a race, silently, with the types still checking out.

The spelling that avoids it is `flatTap`, which is why `workflows.ts` reads as a
flat chain rather than a nesting ladder. It runs a failable step, discards its
value and passes the **original** one through, so each step's error triage and
compensation sit at one level of indentation instead of accumulating — and the
next step is a callback, which cannot start before the previous one settles.

`chargeOrder` above shows it at two steps; `fulfillOrder` runs three the same
way. Where a later step needs an earlier step's _value_ rather than just its
success, `DoAsync().bind(...)` is the same idea with an accumulating scope.

## The external services

`FulfillmentModule` provides `StockService` and `ShippingService`;
`BillingModule` provides `PaymentService` — in a real system other teams'
APIs, here in-memory stand-ins that always say yes and leave a log line,
because what this deployment demonstrates is the orchestration. The
fulfillment specs swap in providers that say no; that is where both of
`fulfillOrder`'s compensation paths run, against the real application and the
real persistence: after a refusal, the spec reads the database through the
same repository the saga used and finds the placement gone. `ShippingService.arrange`
is the deployment's one kernel touchpoint:

<!-- doctest: skip — an excerpt of src/fulfillment.ts, which the gate compiles and runs -->

```ts
arrange: (orderId) =>
  currentUnit()?.signal.aborted === true
    ? fromSafePromise(
        Promise.reject(
          new Error(
            `the drain deadline passed before shipping for ${orderId} was arranged`,
          ),
        ),
      )
    : (logger.info("arranged shipping", { orderId }), OkAsync()),
```

An adapter is where reading the ambient record is legitimate, and here it is
the only route to the unit's `AbortSignal` at all: `activityUnits` calls
`next()` unchanged, so an activity has no parameter to receive one through.
Failing as a **defect** is the point — the platform retries that attempt on
another worker, where the contract's `ShippingUnavailable` is a permanent no
and would be the wrong answer to "we ran out of time". Temporal's own
`Context.current().cancellationSignal` is a different clock, firing on
`shutdownGraceTime`; the two are honoured together. See
[Read the ambient unit from an adapter](/how-to/read-the-ambient-unit).

## The specs: a namespace as a fixture

`test-fixtures.ts` builds the `it` every spec imports. Its `server` fixture is
**file-scoped** — `createNamespace(address, "order-worker")` registers a
namespace on the shared server and waits for every Temporal service's registry
to catch up before handing it over — and its `tenant` fixture is per test.
`serve` boots, through `@btravstack/testing`'s
`boot`, the same `TemporalModule` sugar `main.ts` does, with a per-test task
queue and a workflow bundle memoised per spec file — and composes
`BillingModule` beside whichever fulfillment module the test hands it, since
billing is never swapped:

<!-- doctest: skip — an excerpt of src/test-fixtures.ts, which the gate compiles and runs -->

```ts
const worker = TemporalModule("StubTemporalWorker")({
  contract,
  activities: orderActivities,
  workflows: { workflowBundle },
  imports: [module, BillingModule],
  provides: [fulfillOrder, chargeOrder],
});
```

`provides: [fulfillOrder, chargeOrder]` is there for the same wiring reason
the root's own `imports` list both slices: the composed `orderActivities`'s
own needs are the two pieces' ports, and nothing else in this graph discharges
them.

The stub deployments (`fulfilling`, `outOfStock`, `noShipping`) are each a
`tapped(rootWith(fulfillment, sink), [OrderRepository])`, so a spec reads the
database through the very repository the saga used. Five specs: the
fulfillment saga fulfills in order; a stock refusal walks the placement back;
a shipping refusal releases the reservation and then cancels, in that order;
the duplicate the API answers `CONFLICT` for arrives at the client as
`OrderAlreadyPlaced`, rehydrated by name with its payload intact; and the
billing saga answers on the same task queue as the fulfillment one —
proving every piece was mounted under its own key:

<!-- doctest: skip — an assertion excerpt of src/temporal-runtime.spec.ts, which the gate runs -->

```ts
const { client } = await serve(fulfilling.module);
const charged = client.executeWorkflow("chargeOrder", {
  workflowId: "wf-charge-1",
  args: { orderId: "0199a1e0-0000-7000-8000-00000000a001", amount: 42 },
});
await expect(charged).toBeOkWith({
  authorizationId: "auth-0199a1e0-0000-7000-8000-00000000a001",
});
```

## The drain, honouring the kernel's deadline

This is the first transport where `Serving.drain` is a genuine wait, and the
half that lives in the package rather than the example: `worker.shutdown()`
stops polling at once, `run()` resolves only once the in-flight activity has
finished — on Temporal's `shutdownForceTime`, not the kernel's
`drainTimeoutMs`. The starter races `run()` against the deadline `signal`, so
an activity that never finishes cannot hold `Serving.stop` past the kernel's
deadline; when the deadline wins the kernel gets its thread back, reports the
unit `abandoned`, and the worker keeps winding down on Temporal's clock until
the process exits, since `@temporalio/worker` exposes no public forced
shutdown to escalate to. See
[Draining, in three beats](/explanation/draining-in-three-beats).

## The gate

`needs-gate.test-d.ts` pins `NO RUNTIME — …` (the graph without the starter
fails to match the sentence intersected onto `start`'s `module` parameter) and
the unmet-need refusal spelled with the `temporal()` primitive, since the sugar
cannot leave the activities out at all:

<!-- doctest: skip — quotes src/needs-gate.test-d.ts, the real gate for the unmet-need arm -->

```ts
// @ts-expect-error — UNMET NEED: the module's needs channel carries the activities port, which nothing provides.
const _missingActivities = start(ActivitylessTemporal, options);
```

That second one is the `Needs` channel, not di's `UNSATISFIED DEPENDENCIES`
dependency gate: `start`'s `module` parameter accepts only `Scope | Env`
outstanding, so the activities port fails to assign and the diagnostic ends on
`Type '"TemporalActivities"' is not assignable to type '"@di/Scope"'` — the
port named, after several lines of the contract expanding.

Dropping one slice's import while still providing the composed activities is
a different failure — the runtime `WiringDefect` the wiring rule above
describes — and is not something a compile-time gate can catch, so it is
pinned by the specs instead.

## Where to go next

- The same application, broadcasting: [Order AMQP worker](/examples/order-amqp-worker).
- The package: [`@btravstack/temporal`](/reference/temporal); the task:
  [Run a Temporal worker](/how-to/run-a-temporal-worker).
