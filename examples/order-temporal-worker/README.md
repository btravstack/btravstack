# `@btravstack/core` example: the order fulfillment worker

**What Temporal is for: owning a journey.** This deployment polls **one task
queue** for **two sagas**: `fulfillOrder` — place the order, reserve the
stock, arrange the shipping, walking a later refusal back through the earlier
steps — and `chargeOrder` — authorize the payment, then capture it, refunding
if the capture fails. Both are orchestration, and a durable workflow is the
one place either journey exists as code and survives the process that started
it. The worker is served by
[`@btravstack/temporal-worker`](../../packages/temporal-worker) the way
`order-api` is served by `@btravstack/http-server`; the contract lives in
[`order-temporal-contract`](../order-temporal-contract), because a client that
starts these workflows needs it and needs none of this.

```
src/workflows.ts                    fulfillOrder and chargeOrder — both sagas, in Temporal's deterministic sandbox
src/slices/fulfillment/activities.ts  fulfillOrder's five activities, one piece on the "fulfillOrder" key, built by
                                     TemporalWorkflowActivities from PlaceOrder, OrderRepository, StockService, ShippingService
src/slices/fulfillment/module.ts    FulfillmentSlice — imports the orders vertical plus FulfillmentModule, exports the piece
src/slices/billing/activities.ts    chargeOrder's three activities, one piece on the "chargeOrder" key, built from PaymentService
src/slices/billing/module.ts        BillingSlice — imports BillingModule alone, exports the piece
src/fulfillment.ts                  FulfillmentModule — the two external fulfillment services, as stand-ins
src/billing.ts                      BillingModule — the payment provider, as a stand-in
src/module.ts                       orderActivities = TemporalActivities(orderContract)([fulfillOrder, chargeOrder]);
                                     OrderTemporalWorker — the composition root, importing both slices
src/main.ts                         the process: runMain(OrderTemporalWorker)
src/test-fixtures.ts                boot / serve / server / tenant / fulfilling / outOfStock / noShipping, against the shared Temporal server
```

## Two sagas, two verticals, one queue

`order-temporal-contract` declares two workflows on the one `orders` task
queue — `fulfillOrder` and `chargeOrder` — and this worker is a modulith of
two slices, one per workflow, the same shape
[`order-api`](/examples/order-api)'s HTTP controllers use. Unlike
`order-amqp-worker`'s two subscriber slices, which deliberately own **no**
vertical (a subscriber reacts to a fact somebody else already committed),
these two own genuinely different ones: `FulfillmentSlice` imports the orders
vertical (`OrderApplicationModule` + `OrderPersistenceModule`) plus
`FulfillmentModule`, and `BillingSlice` imports `BillingModule` alone.
`PlaceOrder` is as invisible inside `BillingSlice` as `PaymentService` is
inside `FulfillmentSlice` — the two verticals meet only at the root, in the
list of slices, never inside either slice's own graph.

`TemporalWorkflowActivities(orderContract, key)` mints one piece per workflow
— no port class, no name, since the contract key IS the port's name, and the
piece is typed by the ONE workflow it implements: an activity the workflow
does not declare is a compile error in that slice's own file, not a defect
`declareActivitiesHandler` reports at startup.

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

The root composes both pieces into the one activities record the starter
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

A wiring rule worth stating because the reason isn't obvious:
`orderActivities`'s own `deps` are the two pieces' **ports**, and di's
`flatten` discovers providers only from a module's `imports` and `provides` —
never from a provider's own `deps`. So the root **must** import both
`FulfillmentSlice` and `BillingSlice`, even though nothing in the root ever
names `fulfillOrder` or `chargeOrder` directly. But `TemporalActivities`
itself declares each piece's port as one of its own `deps`, so dropping
either import is an undeclared need at the `TemporalModule(...)` call, and
`pnpm typecheck` refuses it, naming the exact port — a compile error, not a
runtime surprise.

## The fulfillment saga

Three forward steps, each an activity calling into the application layer, and
two compensations the workflow runs **in reverse order of the steps they
undo**:

```
place ──▶ reserveStock ──▶ arrangeShipping ──▶ done
  ▲             ▲ OutOfStock?                 ▲ ShippingUnavailable?
  │             └── cancelPlacement            └── releaseStock, then cancelPlacement
```

## The billing saga

The smallest saga that still has a compensation: authorize, then capture —
and if the capture fails, refund, in reverse order of the step it undoes.

```
authorizePayment ──▶ capturePayment ──▶ done
                          │ activity failure?
                          └── refundPayment
```

`authorizePayment`'s `PaymentDeclined` is a permanent no the contract marks
`nonRetryable` — asking a payment provider to try a refused card five more
times is the bug the discipline prevents. The compensation, `refundPayment`,
declares no errors at all: un-deciding must not be able to answer no.

Both sagas follow the same triage rule per step: a **declared** error is a
permanent domain answer — compensate, then re-mint it against `context.errors`
so the client branches on it by name. Temporal's own machinery tags (an
activity that exhausted its retries unmodelled, or was cancelled) are handed
back as-is and re-raised, and compensation deliberately does **not** run for
them: a step that died mid-flight left unknown state, and un-deciding what you
cannot see is a second bug, not a remedy.

## One subtlety worth stealing

An `AsyncResult` is **eager** — building a step starts its activity — so every
later step in `workflows.ts` is constructed inside the `flatMap` of the one
before it. Hoist them into `const`s and the "sequence" runs as a race.

## The external services

`FulfillmentModule` provides `StockService` and `ShippingService`;
`BillingModule` provides `PaymentService` — in a real system other teams'
APIs, here in-memory stand-ins that always say yes and leave a log line,
because what this deployment demonstrates is the orchestration. The
fulfillment specs swap in providers that say no; that is where both of
`fulfillOrder`'s compensation paths run, against the real application and the
real persistence: after a refusal, the spec reads the database through the
same repository the saga used and finds the placement gone.

## The environment

Read inside the graph — the starter's `TemporalConfig` for the first two, the
kernel for `PROBE_PORT` — never by `main.ts`. A blank or malformed value is a
`ConfigInvalid` the kernel reports as a `startFailed` event and exit `78`.

| Variable             | Default          | What it is           |
| -------------------- | ---------------- | -------------------- |
| `TEMPORAL_ADDRESS`   | `127.0.0.1:7233` | the Temporal service |
| `TEMPORAL_NAMESPACE` | `default`        | must not be blank    |
| `PROBE_PORT`         | `9000`           | `/livez` / `/readyz` |
| `LOG_LEVEL`          | `info`           | the `Logger`'s floor |

The specs boot the same `TemporalModule` sugar with `env: { TEMPORAL_ADDRESS,
TEMPORAL_NAMESPACE, DATABASE_URL }` pointing at the shared servers, so every
test opens and closes a connection of its own — no test can close one under
the next.

## Running the specs

The suite needs a **Docker daemon**. It runs against a real Temporal server —
one `temporalio/auto-setup` container shared by the whole repository
([`internal/test-infra`](../../internal/test-infra/README.md)) — with a
**namespace of this spec file's own**, real Workflow Tasks and real Activity
Tasks. A per-test task queue separates the tests inside the file, and a
per-test **tenant** separates their rows in the application database on the
same PostgreSQL the Temporal server uses.

`tenantId` rides every workflow's arguments and every activity's input, because
the **contract** declares it — `@btravstack/temporal-worker` knows nothing about
tenants. An activity hands `args.tenantId` to the use case, which hands it to
the repository. On the input rather than a Temporal header because an input is
persisted in the event history: a replay a year later reconstructs the tenant
along with everything else.

The
fulfillment saga fulfills, both refusals compensate, the duplicate-order
answer arrives at the client as a typed contract error it can branch on by
name, and the billing saga answers on the same task queue as the fulfillment
one — proving every piece was mounted under its own key.

```bash
pnpm --filter @btravstack/example-order-temporal-worker test        # the saga specs
pnpm --filter @btravstack/example-order-temporal-worker typecheck   # the needs gate
```

The fixtures are [`@btravstack/testing`](../../packages/testing)'s: `serve`
boots the worker through the `boot` fixture, so it is stopped when the test
ends, composing `BillingModule` beside the (real or stubbed) fulfillment
module it is handed — `BillingModule` is never swapped by a spec, so it rides
along as a sibling import the same way `OrderTemporalWorker`'s own root lists
`BillingSlice` beside `FulfillmentSlice` — and `fulfilling` / `outOfStock` /
`noShipping` are `tapped` compositions whose `services()` hand back the very
`OrderRepository` the running deployment holds — how the compensation specs
read the state back. Each also composes `observability({ sink })`, so
`lines()` is the saga's own log: the step assertions read
`{ message, orderId, quantity }` as fields, and the activity trace id every
line carries is the runtime's business rather than something to strip out of
a string.

## What this deployment deliberately is not

It is not a broadcast. Every activity here is _addressed_ — a workflow asks a
specific step to happen next and waits for the answer, because each journey
has an owner and an order. When a fact just needs saying to whoever listens,
that is an event, and it lives in [`order-amqp-worker`](../order-amqp-worker).
