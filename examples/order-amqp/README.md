# `@btravstack/start-core` example: the order AMQP worker

The fourth deployment. The same application, the same persistence, the same
composition — driven by a real message broker instead of an HTTP server, an
in-memory queue or a durable execution engine, and served by
[`@btravstack/start-amqp`](../../packages/start-amqp) the way `order-api` is
served by `@btravstack/start-http` and `order-temporal` by
`@btravstack/start-temporal`. The contract it implements lives in
[`order-amqp-contract`](../order-amqp-contract), because a publisher that
sends a placement needs it and needs none of this.

```
src/amqp-runtime.ts   the runtime's application half: the contract, the needs, and the handler's triage
src/module.ts          OrderAmqpModule — the composition root
src/env.ts             process.env validated through a schema, as a Result
src/main.ts            the process: readEnv + start + runMain
src/test-fixtures.ts   serve / tapped / unmodelled / gate, as Vitest fixtures, against a real RabbitMQ
```

## The point of this package

`OrderAmqpModule` is `OrderApiModule`, `OrderWorkerModule` and
`OrderTemporalModule` with a different name:

```ts
export const OrderAmqpModule = Module("OrderAmqp")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, FindOrder, Logger],
});
```

Nothing in `order-application` or `order-infrastructure` changed to make this
work, and nothing could have. **One process, one runtime** was already three
composition roots and three `Runtime` values; a fourth one, over a broker as
unlike a durable execution engine as it is unlike HTTP, is what turns "three"
into an unremarkable pattern.

## The same `Err`, four transports

`DuplicateOrder` is one value. Over HTTP there is a caller waiting to be told,
so it becomes a `CONFLICT` the client receives **as a value**. On the
in-memory queue there is no caller, so the message is **dead-lettered**. On
Temporal there is a caller again — a workflow, and behind it a client — so it
becomes a **typed contract error**. Here there is no caller either — a
publisher fired the message and moved on — so it becomes a
`NonRetryableError`: the broker's own vocabulary for "park it, do not ask
again."

| unthrown               | oRPC (`order-api`)      | queue (`order-worker`)      | Temporal (`order-temporal`)             | AMQP (this package)                                      |
| ---------------------- | ----------------------- | --------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `Ok(order)`            | the procedure's output  | **ack**                     | the workflow's output                   | **ack**                                                  |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | **dead-letter**             | `InvalidQuantity`, **non-retryable**    | `NonRetryableError`, **parked**                          |
| `Err(DuplicateOrder)`  | `CONFLICT`              | **dead-letter**             | `OrderAlreadyPlaced`, **non-retryable** | `NonRetryableError`, **parked**                          |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retry**, then dead-letter | **retried by the platform**, then fails | `RetryableError`, **retried by the broker**, then parked |

The retry budget is contract configuration rather than a runtime constant —
`order-placements`'s `retry: { mode: "ttl-backoff", maxRetries: 3 }` — the
sharper form of the same claim the Temporal contract makes with
`nonRetryable`: naming a failure decides not only what happens to the message
but what the platform does next.

## The triage, and the real signature it turned on

```ts
const placeHandler = (contract: OrderContract) =>
  declareHandler<OrderContract, "placeOrder", MessageUnitContext<AmqpNeeds>>(
    contract,
    "placeOrder",
    (message, _raw, { context }) =>
      context.ctx
        .get(PlaceOrder)
        .execute(message.payload.orderId, message.payload.quantity)
        .map(() => undefined)
        .mapErrCases((matcher) =>
          matcher.with(
            P.tag("InvalidQuantity"),
            P.tag("DuplicateOrder"),
            (error) => new NonRetryableError(error._tag, error),
          ),
        )
        .recoverDefect((cause) =>
          ErrAsync(new RetryableError("placing the order failed", cause)),
        ),
  );
```

Built from the `contract` `orderAmqpRuntime` itself is handed, rather than
from the module's own top-level `orderContract` — the same reason
`-temporal`'s `activities` builder threads its own `contract` into
`declareActivitiesHandler` — so the parameter is load-bearing rather than a
decorative pass-through.

Both `InvalidQuantity` and `DuplicateOrder` collapse into the **same** arm,
unlike Temporal's two separate `errors.InvalidQuantity` / `errors.OrderAlreadyPlaced`
constructors — AMQP has no client waiting to branch on the name, so there is
nothing to preserve past "do not retry this."

`NonRetryableError`'s constructor is `(message: string, cause?: unknown)` — a
`TaggedError`, not the free-form shape a first guess might reach for. Passing
`error` itself as the `cause` keeps the original domain error attached for
whoever reads the parked message's logs, the library's own documented pattern
(`new RetryableError('Payment failed', error)`).

### `Defect` is not auto-retried here, unlike the other two runtimes

`order-worker`'s `dispositionOf` explicitly folds `defect` into `retry`, and
Temporal's activity boundary re-throws a `Defect`'s cause so the platform's
_own_ retry policy picks it up. Measured directly against a real broker,
`@amqp-contract/worker` does **neither**: an `AsyncResult` that settles as a
`Defect` here is nacked once, immediately, under its original routing key,
never touching `order-placements`'s `retry` budget at all —
`routeHandlerError`'s `handleError` is reached only for a value already turned
into a `RetryableError` / `NonRetryableError`. So the `.recoverDefect(...)`
above is not decoration: without it, an infrastructure failure is parked on
the first attempt exactly like a named domain error, and "infrastructure comes
back" would be false on this transport alone.

`retry.maxRetries: 3` also means something subtly different here than
Temporal's `maximumAttempts: 3`: it is retries **on top of** the first try, so
an unmodelled failure that never recovers is attempted **four** times in
total before it is parked — see `src/amqp-runtime.spec.ts`'s
`unmodelled.attempts()` assertion.

## The handler and the middleware are two independent generic calls

Unlike `temporal-contract`'s single `declareActivitiesHandler`, `amqp-contract`
separates `declareHandler` from the middleware slot entirely. **Both** need
their type arguments given explicitly:

```ts
declareHandler<OrderContract, "placeOrder", MessageUnitContext<AmqpNeeds>>(...)
middleware: (host) => messageUnits<AmqpNeeds>(host)
```

Leave either bare and TypeScript infers `EmptyContext` from the call it is
still resolving, and `context.ctx` silently stops existing inside the handler
— caught twice already, in `packages/start-amqp`'s own suite (once for
`messageUnits`, once for `declareHandler` — a second, independent generic
call `-temporal`'s single `declareActivitiesHandler` never needed), and the
reason this package's runtime file mirrors that shape exactly rather than
reaching for `declareActivitiesHandler`'s one-generic convenience.

## The delivery is the unit, and one line is what makes it one

```ts
middleware: (host) => messageUnits<AmqpNeeds>(host),
```

`messageUnits` opens the kernel unit and injects the application context
through `amqp-contract`'s own per-message context channel — the same shape
`activityUnits` gives Temporal's activities. `needs` is `[PlaceOrder, Logger]`
rather than empty for the same reason as every sibling: the handler resolves
both out of the application context, and `start`'s phantom rest-tuple gate
proves the module exports them before anything runs.

## `TypedAmqpWorker` owns its own connection

Unlike `order-temporal`'s `main.ts`, this deployment's has no connection dance:
there is nothing to open before `start` and nothing to close after it.
`amqpRuntime` is handed the broker URLs and connects itself, so `main.ts` is
the simplest of the four — `readEnv` + `start` + `runMain`, with no `.finally`.

## `Serving.info` with a queue in it, no port and no task queue

```ts
const info = (await app.runtimeInfo()).get(); // { queues: ["order-placements"] }
```

Derived from the contract rather than configured, so it cannot disagree with
what the worker actually consumes — see `queuesOf` in
`packages/start-amqp/src/amqp-runtime.ts`.

## Running it — and the one thing this example needs that most do not

```bash
pnpm --filter @btravstack/start-example-order-amqp test        # runtime specs + env specs
pnpm --filter @btravstack/start-example-order-amqp typecheck   # the needs gate
```

**A Docker daemon.** `@amqp-contract/testing` boots one real RabbitMQ
container per vitest run (`globalSetup`), and every test in the suite gets its
own vhost — isolation that costs nothing per test, and the reason no test here
scopes its own queue name the way `order-temporal`'s scopes a task queue.

`src/needs-gate.test-d.ts` pins the compile-time half: `orderAmqpRuntime`
declares `[PlaceOrder, Logger]` — two of the three ports the module exports,
because a runtime declares what _it_ needs — and a module missing either fails
`start`'s arity gate before anything runs.

Every helper the specs need is a Vitest fixture in `src/test-fixtures.ts`, so
each file opens on `describe` and each test names its dependencies in its own
parameter list. Shutting an app down is the `serve` fixture's job, which is why
no test here has a `try`/`finally`.

## No request/response, so the duplicate spec races nothing

`order-temporal`'s and `order-worker`'s duplicate-order specs chain a second
call onto the first's settlement — `executeWorkflow(...).flatMap(() =>
executeWorkflow(...))`, `queue.publish(...).flatMap(() => queue.publish(...))`
— because their transports hand back a result to chain on. AMQP is
fire-and-forget: nothing here settles. The spec publishes both placements
without waiting between them and lets the real database's own uniqueness
constraint decide which one wins, exactly the guarantee
`order-infrastructure`'s own suite exercises directly — the outcome is the
same regardless of which delivery the broker happens to process first.
