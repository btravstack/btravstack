---
title: Order Temporal worker example
description: The orchestration deployment — TemporalActivities and TemporalModule over the order contract, a fulfillment saga compensating in reverse, mapErrCases making a domain Err a nonRetryable contract error, the cached time-skipping test server, and a drain that honours the kernel's deadline.
---

# Order Temporal worker

[`examples/order-temporal-worker`](https://github.com/btravstack/start/tree/main/examples/order-temporal-worker)
— the orchestration deployment: [the order application](/examples/order-application)
owning a journey, served by [`@btravstack/temporal`](/reference/temporal).

```sh
pnpm turbo run test --filter=@btravstack/example-order-temporal-worker
```

::: warning Network, once
The suite runs a real `@temporalio/worker` Worker against Temporal's
**time-skipping test server** — a 64 MB local binary, not a container. It is
fetched once into `<repo>/.cache/temporal-test-server` (gitignored) and kept
for a year, so the one thing this example needs that the others do not is
network access on a **cold cache**. Measured: about 7.4 s cold, under 4 s warm.
:::

## The activities: a service, closing over what it declares

`activities.ts` is the application's half. `TemporalActivities(orderContract)`
is di's `Provider(port)` builder on the starter's own activities port, typed
for the contract — its service the implementations record
`declareActivitiesHandler` takes; no class, no name, since a worker serves one
activities record — so the next call declares the four ports the five
activities close over. Nothing is resolved from a context.

```ts
export const orderActivities = TemporalActivities(orderContract)(
  [PlaceOrder, OrderRepository, StockService, ShippingService],
  {
    sync: (place, repository, stock, shipping) => ({
      fulfillOrder: {
        place: (args, { errors }) =>
          place
            .execute(args.orderId, args.quantity)
            .map((order) => ({ id: order.id, quantity: order.quantity }))
            .mapErrCases((matcher) =>
              matcher
                .with(P.tag("InvalidQuantity"), (error) =>
                  errors.InvalidQuantity({ id: error.id }),
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
            .remove(args.orderId)
            .recoverErrCases((matcher) =>
              matcher.with(P.tag("OrderNotFound"), () => undefined),
            ),
      },
    }),
  },
);
```

`place` is the hinge. Its `mapErrCases` is the same triage
[`order-api`](/examples/order-api) performs into `ORPCError` codes, and the
same `Err` lands somewhere else again: `DuplicateOrder` becomes
`OrderAlreadyPlaced`, a typed contract error the client branches on by name.
What is new is the **second** thing this mapping decides. The contract
declares both errors `nonRetryable`, so naming a failure here also tells
Temporal to stop retrying it; an unmodeled failure stays unnamed and the
retry policy takes over — the platform doing for free what a hand-rolled
worker spells as an attempt budget. Every case is named, so a new domain
error is a compile error at the one place that decides what the workflow sees.

The compensations declare no errors: compensation is the saga un-deciding, and
a step that could answer "no" would leave it stuck half-done.
`cancelPlacement` absorbs `OrderNotFound` on purpose — undoing a placement
that never landed is the no-op a **repeated** compensation performs, and an
activity Temporal may re-run has to answer the same both times.

## The workflow: the saga, in the sandbox

`workflows.ts` has to be its own module: workflow code runs in a
deterministic V8 sandbox that is bundled separately, and it must be free of
side effects at module scope. Nothing in it reaches di or the database —
those live behind the activities, where the kernel's units open.

The rule per step: a **declared** error is a permanent domain answer —
compensate, then re-mint it against `context.errors` so the client sees it
typed; Temporal's own machinery tags (an activity that exhausted its retries
unmodeled, or was cancelled) are handed back as-is and re-raised by
`propagateActivityFailure`, and compensation deliberately does **not** run for
them, since a step that died mid-flight left unknown state. The first
walk-back:

```ts
context.activities
  .reserveStock({ orderId: args.orderId, quantity: args.quantity })
  .flatMapErrCases((matcher) =>
    matcher
      // The first walk-back: stock said a permanent no, so the
      // placement is un-decided before the caller hears it.
      .with({ errorName: "OutOfStock" }, (error) =>
        context.activities
          .cancelPlacement(order)
          .flatMap(() =>
            ErrAsync(context.errors.OutOfStock({ id: error.data.id })),
          ),
      )
      .with(
        P.tag(ACTIVITY_ERROR_TAG),
        P.tag(ACTIVITY_CANCELLED_ERROR_TAG),
        (error) => ErrAsync(error),
      ),
  );
```

The shipping refusal walks back deeper, in reverse order of the steps it
undoes — `releaseStock`, then `cancelPlacement`. One subtlety worth stealing:
an `AsyncResult` is **eager**, so building a step starts its activity, and
every later step is constructed inside the `flatMap` of the one before it.
Hoist them into `const`s and the "sequence" runs as a race.

## The composition root, and the process

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
    observability(),
  ],
});
```

The same `OrderApplicationModule` + `OrderPersistenceModule` pair as the API, plus
[`observability()`](/reference/observability) — the `Logger` the use case and
the stand-ins write to, bound from `LOG_LEVEL`, JSON per line on stdout, every
line carrying the activity attempt's own trace id — and
`FulfillmentModule` — the two external services as in-memory stand-ins that
say yes to anything the drain still has time for, because what this deployment
demonstrates is the orchestration; the specs swap in twins that say no.
`ShippingService.arrange` is the exception, and the deployment's one kernel
touchpoint:

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

`TemporalModule` imports
the starter (`TemporalRuntime`, `TemporalConfig` from `TEMPORAL_ADDRESS` /
`TEMPORAL_NAMESPACE`, `TemporalConnection` as a resource of the graph),
provides the activities and exports the runtime. `main.ts` is
`await runMain(OrderTemporalWorker);` — a service that will not answer is the
starter's `TemporalUnreachable`, exit `1`; a bad variable is `startFailed` and
exit `78`.

## The specs: the time-skipping server as a fixture

`test-fixtures.ts` builds the `it` every spec imports from
`@temporal-contract/testing`'s `createTimeSkippingTest`, pointing the
downloader at the repo-local cache:

```ts
const downloadDir = fileURLToPath(
  new URL("../../../.cache/temporal-test-server/", import.meta.url),
);

export const it = createTimeSkippingTest({
  server: { executable: { type: "cached-download", downloadDir, ttl: "365d" } },
});
```

(the real file goes on to `.extend` that `it` with `boot`, `serve`,
`fulfilling`, `outOfStock` and `noShipping`.) Both values are deliberate: the
SDK's defaults are the OS temp directory, which CI wipes between jobs, and a
one-day ttl, so a developer running the suite twice in a week would download
it twice. `boot` is `@btravstack/testing`'s `bootFixture()`, which stops every
app it started when the test ends; the `serve` fixture then boots, through
it, the same `TemporalModule` sugar `main.ts` does, with a per-test task queue
(`withTaskQueue(orderContract, nextTaskQueueId("orders"))`), a workflow bundle
memoised per spec file, and `env: { TEMPORAL_ADDRESS: testEnv.address }` — so
every test opens and closes a connection of its own:

```ts
const app = boot(worker, { env: { TEMPORAL_ADDRESS: testEnv.address } });
```

The stub deployments (`fulfilling`, `outOfStock`, `noShipping`) are each a
`tapped(rootWith(fulfillment, sink), [OrderRepository])`, so a spec reads the
database through the very repository the saga used. The log lines need no tap
at all: `rootWith` composes `observability({ sink })`, so `lines()` hands back
the saga's own `Line` values — `{ message, orderId, quantity }` as fields, and
the trace id already on each one.

Four specs: the saga fulfills in order; a stock refusal walks the placement
back; a shipping refusal releases the reservation and then cancels, in that
order, and the spec reads the database through the same repository the saga
used and finds the placement gone; and the duplicate the API answers
`CONFLICT` for arrives at the client as `OrderAlreadyPlaced`, rehydrated by
name with its payload intact:

```ts
errCases: (matcher) =>
  matcher
    .with({ errorName: "OrderAlreadyPlaced" }, (error) => `conflict:${error.data.id}`)
    .with({ errorName: "InvalidQuantity" }, () => "WRONG ERROR")
    .with({ errorName: "OutOfStock" }, () => "WRONG ERROR")
    .with({ errorName: "ShippingUnavailable" }, () => "WRONG ERROR")
    .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
    .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
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

`needs-gate.test-d.ts` pins `NO RUNTIME` (the graph without the starter fails
on arity) and di's gate: the sugar without `FulfillmentModule` still owes
`StockService | ShippingService`, which `start` — accepting only `Scope | Env`
outstanding — refuses.

```ts
// @ts-expect-error — UNMET NEED: `StockService | ShippingService` is not assignable to `Env | Scope`.
const _missingFulfillment = start(FulfillmentlessTemporal, options);
```

## Where to go next

- The same application, broadcasting: [Order AMQP worker](/examples/order-amqp-worker).
- The package: [`@btravstack/temporal`](/reference/temporal); the task:
  [Run a Temporal worker](/how-to/run-a-temporal-worker).
