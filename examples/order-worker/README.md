# `@btravstack/start` example: the order worker

The second deployment. The same application, the same persistence, the same
composition — consumed off a queue instead of served over HTTP.

```
src/queue.ts           the broker, reduced to what a worker needs of one
src/queue-runtime.ts   the Runtime: start / drain / stop, and the ack/retry/dead-letter mapping
src/module.ts          OrderWorkerModule — the composition root
src/env.ts             process.env validated through a schema, as a Result
src/main.ts            the process: readEnv + start + runMain
src/test-fixtures.ts   serve / queue / gate / tapped, as Vitest fixtures
```

## The point of this package

`OrderWorkerModule` is `OrderApiModule` with a different name:

```ts
export const OrderWorkerModule = Module("OrderWorker")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [],
  exports: [PlaceOrder, FindOrder, Logger],
});
```

Nothing in `order-application` or `order-infrastructure` changed to make this
work, and nothing could have: the use cases return a `Result`, and what a
`Result` means to a transport is the transport's business. **One process, one
runtime** is not a slogan the kernel makes you take on trust — it is two
composition roots, two `Runtime` values, and one application underneath.

## The same `Err`, two transports

`DuplicateOrder` is one value. Over HTTP there is a caller waiting to be told,
so it becomes a `CONFLICT` the client receives **as a value**. On a queue there
is no caller, so the message is **parked** for a human instead.

| unthrown               | oRPC (`order-api`)      | queue (this package)        |
| ---------------------- | ----------------------- | --------------------------- |
| `Ok(order)`            | the procedure's output  | **ack**                     |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | **dead-letter**             |
| `Err(DuplicateOrder)`  | `CONFLICT`              | **dead-letter**             |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retry**, then dead-letter |

The third row is the sharp one and the fourth is its mirror. An unmodelled
failure is the infrastructure one — a dropped connection, a pool timeout — and
infrastructure comes back, so it is the one thing worth another delivery. A
modelled error never is: a redelivery would ask the same impossible thing again.

```ts
ctx
  .get(PlaceOrder)
  .execute(job.orderId, job.quantity)
  .match({
    ok: () => ack,
    errCases: (matcher) =>
      matcher
        .with(P.tag("InvalidQuantity"), (error) => deadLetter(error._tag))
        .with(P.tag("DuplicateOrder"), (error) => deadLetter(error._tag)),
    defect: (cause) => retry(String(cause)),
  });
```

Every case is named — this repo bans `P._`, and there is no `.otherwise()`. A
new domain error is a compile error here **and** in `order-api/src/router.ts`,
at the two places that have to decide what it means.

## Acking is flushing

The disposition is applied **inside the unit**, exactly as the API writes its
response inside the unit:

```ts
host.run(metaFor(delivery), (ctx, _signal) =>
  dispositionOf(ctx, delivery.job).flatMap((disposition) =>
    dispose(ctx.get(Logger), queue, delivery, maxAttempts, disposition),
  ),
);
```

A unit closes the instant its `Result` settles, and an idle registry is the
kernel's permission to call `Serving.stop()`. Settling the message afterwards
would race that: the message would be neither acked nor requeued when the
process went away. Flushing a response and acking a message are the same
obligation, wearing different clothes.

## A delivery is the unit; the message is the trace

```ts
const metaFor = (delivery: Delivery): UnitMeta => ({
  kind: "job",
  id: `${delivery.job.id}#${delivery.attempt}`,
  traceId: delivery.job.id,
});
```

`UnitMeta.id` must be unique per unit, and a message id is not one: a retried
message is delivered twice and is two units. So the **delivery** is the id, and
the message id becomes the `traceId` — which is exactly what `traceId` is for.
It is the correlation id, minted outside this process, and holding it steady
across attempts is what joins three deliveries into one trace.

## A publish resolves on a **worker**, not on a broker

`OrderQueue.publish` hands the producer the consumer's outcome:

```ts
await expect(queue.publish(aJob("job-1", "o-1", 2))).toBeOkWith({
  jobId: "job-1",
  outcome: "acked",
  attempts: 1,
});
```

That is a test convenience, and it carries a precondition worth stating: a real
AMQP `publish` resolves on the **broker's** ack and the producer never learns
how the message ended. Here it resolves when a **running worker settles** the
job — so the attempt budget, which bounds the retries of a job a worker has
claimed, says nothing about a job being claimed at all. Publish with no worker
running, or leave a message behind when one drains, and the returned
`AsyncResult` **never settles**: awaiting it waits forever.

That is not a bug in the queue — it is what a broker does with an unconsumed
message, and `Serving.drain` stopping at _claiming_ is the right shape (the
next worker on the queue takes it). It is a bug waiting to happen in a spec, so
two of them pin it, racing the publish against one macrotask turn rather than
awaiting it: _"never settles a job published with no worker running"_ and
_"leaves a job the drain never claimed unsettled, without waiting for it"_. Both
fail in a millisecond instead of hanging until Vitest's timeout.

## `Serving.info` with no port in it

```ts
const info = (await app.runtimeInfo()).get(); // { queue: "orders", concurrency: 1 }
```

The API publishes `{ port, prefix }` on the same channel. That is why `Info` is
the runtime's own type parameter rather than a port number baked into the
kernel: a queue consumer has none, and what an operator wants to know about one
is which queue it is on and how many messages it will take at a time.

## Running it

```bash
pnpm --filter @btravstack/start-example-order-worker test        # 9 runtime specs + 4 env specs
pnpm --filter @btravstack/start-example-order-worker test:types  # the needs gate
```

`src/needs-gate.test-d.ts` pins the compile-time half: `queueWorkerRuntime`
declares `[PlaceOrder, Logger]` — two of the three ports the module exports,
because a runtime declares what _it_ needs — and a module missing either fails
`start`'s arity gate before anything runs.

Every helper the specs need is a Vitest fixture in `src/test-fixtures.ts`, so
each file opens on `describe` and each test names its dependencies in its own
parameter list. Shutting an app down is the `serve` fixture's job, which is why
no test here has a `try`/`finally`.

`src/main.ts` is the process itself. It creates the queue, because this
example's broker is a plain in-memory object; a real deployment builds an AMQP
channel from the environment instead, and nothing above that line changes. Like
`order-api`'s, it is typechecked by the gate rather than executed by it — the
example packages are source-only, and every spec drives `start` directly.
