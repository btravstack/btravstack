---
title: Run a Temporal worker
description: Provide a temporal-contract's activities as a di service, compose the worker with TemporalModule, and let the kernel own the Worker's lifecycle and drain.
---

# Run a Temporal worker

> **How-to.** Boot a Temporal worker under the kernel: activities built from
> your own services, the connection as a resource of the graph, and a drain
> that releases the kernel at the kernel's deadline. For the package's full
> surface, see [`@btravstack/temporal`](/reference/temporal); for _why_ the
> drain needs a package of its own, see
> [Draining, in three beats](/explanation/draining-in-three-beats).

You have a [`temporal-contract`](https://github.com/btravstack/temporal-contract)
contract and the use cases its activities call. What you write is the
activities record and a composition root; the Worker's `create` / `run` /
`shutdown`, the unit per activity attempt and the deadline race are the
package's. Everything below is lifted from `examples/order-temporal-worker`.

## Recipe

1. Implement the activities with `TemporalActivities(contract)(deps, arm)`
   — a record shaped like the contract, closing over the services `deps` names.
2. Compose with `TemporalModule(name)({ contract, activities, workflows, imports })`.
3. `await runMain(OrderTemporalWorker)`.
4. Set `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` in the deployment; keep
   `forceAfter` at or below the kernel's `drainTimeoutMs`.

## Step 1 — the activities, as a provider

`TemporalActivities(orderContract)` is di's `Provider(port)` on the starter's
own activities port, typed for the contract (its service the record
`declareActivitiesHandler` takes) — no class, no name: a worker serves one
activities record — so the next call is `(deps, arm)` as anywhere else. **An activity is a closure over its provider's services** — nothing is
read from a context at call time — and each `mapErrCases` names every domain
error the contract declares:

A single record covers **every** workflow the contract declares — `orderContract`
has two, `fulfillOrder` and `chargeOrder`:

```ts
import {
  OrderRepository,
  PaymentService,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalActivities } from "@btravstack/temporal";
import { P } from "unthrown";

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

The package maps nothing further: `declareActivitiesHandler` already turns a
declared contract error into a `nonRetryable` `ApplicationFailure` the workflow
branches on, and leaves anything unmodeled to Temporal's retry policy. Naming
a failure here is also what tells Temporal to stop retrying it.

`args.tenantId` is the application's own, declared on every workflow and
activity input by the **contract** — so Temporal persists it in the event
history and a replay reconstructs it, and the package reads nothing about
tenancy. `TenantId(…)` claims `examples/order-domain`'s brand at each activity
that needs one, an activity being its own entry point; it casts rather than
parses, because the contract already validated the field as a UUIDv7. The
brand is what stops `execute(args.orderId, args.tenantId)` from compiling.
`cancelPlacement` absorbs `OrderNotFound` on purpose — a compensation Temporal
may re-run has to answer the same both times.

## Step 2 — the composition root

```ts
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { TemporalModule } from "@btravstack/temporal";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { orderActivities } from "./activities.js";
import { BillingModule } from "./billing.js";
import { FulfillmentModule } from "./fulfillment.js";

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
    observability(),
  ],
});
```

`TemporalModule` is `Module(name)({...})` plus the starter's fields: it
imports `temporal({ contract, workflows, … })`, provides the activities and
exports `TemporalRuntime`. [`observability()`](/reference/observability) is the
other starter in the list — the `Logger` the use case, the fulfillment
services and the billing stand-in write to, bound from `LOG_LEVEL`, JSON per
line on stdout, every line carrying the activity attempt's own trace id. The
starter's runtime provider depends on its activities port through di, so a
root whose imports do not cover what the provider declared (`FulfillmentModule`
and `BillingModule` here — `chargeOrder`'s `PaymentService` comes from the
latter) is refused at `start` — the `Needs` channel failing to assign against
`Env | Scope`, which names the port, not di's `UNSATISFIED DEPENDENCIES` arity
gate; a root with no starter is refused against
`"NO RUNTIME — the module exports no port declared over RuntimePort"`.
`activities` is typed against the module's own
`contract`: a provider built for another contract is refused at the call.

`workflows` is a `WorkflowSource`: `{ workflowsPath }` for a process that lets
Temporal bundle the module, `{ workflowBundle }` for a spec that built one and
memoised it.

## Step 3 — `main.ts`

```ts
import { runMain } from "@btravstack/core";

import { OrderTemporalWorker } from "./module.js";

await runMain(OrderTemporalWorker);
```

## Configuration and options

`temporal()` provides three ports: `TemporalRuntime`, `TemporalConfig`
(`{ address, namespace }`) and `TemporalConnection` — the `NativeConnection`
as a **resource**, opened with the scope and closed on every exit path,
startup failure included.

| Variable / option                  | Default          | Notes                                                       |
| ---------------------------------- | ---------------- | ----------------------------------------------------------- |
| `TEMPORAL_ADDRESS` / `address`     | `127.0.0.1:7233` | a blank value is a `ConfigInvalid`, exit `78`               |
| `TEMPORAL_NAMESPACE` / `namespace` | `default`        | likewise                                                    |
| `gracePeriod`                      | `10 seconds`     | Temporal's `shutdownGraceTime`                              |
| `forceAfter`                       | `15 seconds`     | Temporal's `shutdownForceTime` — keep it ≤ `drainTimeoutMs` |

`address` / `namespace` **pin** a field instead of reading it — explicit beats
environment beats default, per field:

```ts
export const Pinned = TemporalModule("OrderTemporalWorkerLocal")({
  contract: orderContract,
  activities: orderActivities,
  workflows: {
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  },
  address: "127.0.0.1:7233",
  gracePeriod: "5 seconds",
  forceAfter: "15 seconds",
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    FulfillmentModule,
    BillingModule,
    observability(),
  ],
});
```

A service that will not answer is a modeled **`TemporalUnreachable`**
`{ address, cause }` — a startup `Err`, so `runMain` exits **`1`**: an
operator can act on it, and it is not the `70` a defect earns. A contract the
activities record cannot satisfy (an implementation the contract never
declared, one it declares and finds missing) is `RuntimeStartFailed`, also `1`.

## Read what the worker published

Once polling, the runtime publishes `TemporalInfo` — `{ taskQueue, namespace }` —
on `Serving.info`:

```ts
const app = start(OrderTemporalWorker, {
  env: { TEMPORAL_ADDRESS: "127.0.0.1:7233" },
  signals: false,
  probes: false,
});
const info = (await app.runtimeInfo()).get(); // TemporalInfo | undefined
```

The specs boot the same `TemporalModule` sugar with `env: { TEMPORAL_ADDRESS,
TEMPORAL_NAMESPACE }` pointing at the Temporal server the whole repository
shares — a namespace of the spec file's own, a per-test task queue and a
memoised bundle.

## The drain, and the one surprising behaviour

`Serving.drain(signal)` calls `worker.shutdown()` — polling stops at once,
in-flight activities run to completion — then waits on `run()` **raced against
the kernel's deadline signal**. `run()` settles on Temporal's own
`shutdownForceTime`, not the kernel's `drainTimeoutMs`, so without the race an
activity that never finishes would hold `Serving.stop` well past the kernel's
deadline.

::: warning When the deadline wins
The runtime returns and the worker is still alive: `@temporalio/worker`
exposes no public forced shutdown, so "stop waiting" is the only escalation.
The kernel gets its thread back on time, reports the activity `abandoned`
(exit `2` under `runMain`), and the worker keeps winding down on Temporal's
clock until the process exits.
:::

Keep `forceAfter` at or below `drainTimeoutMs` (default `20_000`). It matters
most on the `stop()`-only path — no signal, no kernel deadline — where
Temporal's clock alone decides when `Serving.stop` returns. The package cannot
do this for you: `drainTimeoutMs` is a `StartOptions` field the runtime never
sees.

## The unit boundary

One unit per activity **attempt**, not per execution: `UnitMeta.id` is
Temporal's base64 task token — unique per attempt by Temporal's guarantee —
and `traceId` is the workflow id, the correlation id minted outside this
process and stable across every retry. An adapter reads either from
`currentUnit()`; the middleware injects nothing into the activity itself.

## Honouring the drain deadline

Because the middleware injects nothing, `currentUnit()?.signal` is the **only**
route to the unit's `AbortSignal` from inside an activity — there is no
parameter to receive one through, and adding a context the contract does not
type was the alternative. It is aborted at the kernel's `drainTimeoutMs`:

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

Failing as a **defect** is deliberate: the platform retries that attempt on
another worker, which is what "we ran out of time here" means. A modeled
contract error — `ShippingUnavailable` — is a permanent no and would be wrong.

Temporal's own `Context.current().cancellationSignal` is a **different clock**:
it fires on a workflow-side cancellation, and on worker shutdown after
`shutdownGraceTime`. Honour both; neither stands in for the other.

## See also

- [`@btravstack/temporal`](/reference/temporal) — options, ports, `TemporalInfo`, `WorkflowSource`.
- [Split a worker into slices](/how-to/split-a-worker-into-slices) — several
  workflows, one activities record per workflow, composed at the root.
- [Order Temporal worker](/examples/order-temporal-worker) — the saga these samples come from.
- [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes) — `drainTimeoutMs` against `terminationGracePeriodSeconds`.
- [Configure from the environment](/how-to/configure-from-the-environment) — how `TEMPORAL_*` are bound and pinned.
