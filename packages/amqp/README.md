# @btravstack/amqp

**The AMQP consumer runtime for
[`@btravstack/core`](https://github.com/btravstack/start): one unit per
delivery, and a drain with exactly one deadline — the kernel's own.**

It runs an [`amqp-contract`](https://github.com/btravstack/amqp-contract)
`TypedAmqpWorker` under the kernel's lifecycle: bind the connection, open one
kernel unit per delivery through a middleware, and — unlike `@btravstack/temporal`,
which races the kernel's deadline against a library that also keeps its own —
tell the library to wait forever and let the kernel's signal be the only
clock in the process.

## Install

```sh
pnpm add @btravstack/amqp @btravstack/core @btravstack/di unthrown \
  @amqp-contract/worker @opentelemetry/api
```

All five are peer dependencies — install them. `@opentelemetry/api` is one
because `@amqp-contract/worker` itself peers on it; `@amqp-contract/contract`
is **not** in this list — it is a devDependency of this package, used only to
type its own tests, and never appears in the published type surface. Node
`>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A worked example

```ts
start(AppModule, {
  runtime: amqpRuntime({
    urls: ["amqp://localhost"],
    contract: orderContract,
    needs: [PlaceOrder, Logger],
    handlers: () => ({
      placeOrder: declareHandler<
        typeof orderContract,
        "placeOrder",
        MessageUnitContext<typeof PlaceOrder | typeof Logger>
      >(orderContract, "placeOrder", (message, _raw, { context }) =>
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
      ),
    }),
    middleware: (host) => messageUnits<typeof PlaceOrder | typeof Logger>(host),
  }),
});
```

`amqp-contract` separates the handler from the middleware slot entirely —
unlike `@btravstack/temporal`'s single `declareActivitiesHandler` call, this is **two**
independent generic calls, and **both** need their type argument given
explicitly: `declareHandler<...>` and `messageUnits<...>(host)`. TypeScript
infers the injected context from each call's own type and infers nothing from
a generic call it is still resolving, so either one left bare and inline
leaves `context.ctx` untyped inside the handler that reads it — caught twice
in this package's own development, which is why it is stated here rather than
left for the next consumer to find the same way.

`handlers` is a builder rather than a finished record, for the same reason
`@btravstack/temporal`'s `activities` is: `messageUnits` needs the `RuntimeHost` to open
units against, and the host does not exist until `start` calls the runtime. Its
return type is `WorkerInferHandlers<TContract, MessageUnitContext<Needs>>`,
checked against the `contract` passed alongside it — a typo'd key or a missing
one is a compile error rather than a defect on the first delivery. Both
`handlers` and `middleware` builders are called **inside** `createWorker`'s
qualified chain, not before it: a throw from either — `declareHandler` on a
contract it cannot satisfy, say — is a startup failure like any other,
`Err(RuntimeStartFailed)` and exit `1`, not a `Defect` and exit `70`.

## What it owns, and what it declines

It owns the worker's connection, the unit boundary around every delivery, and
the release at the kernel's deadline.

It does **not** map a `Result` to ack / retry / dead-letter — and here the
honest answer is a **three-way split**, not the clean one-line handoff
`@btravstack/temporal` gets to make. `amqp-contract`'s own dispatch routes a modeled
`RetryableError` / `NonRetryableError` by the queue's `retry` config — that
much the library owns. A `Defect` is the third thing, and it is **not**
routed the same way: `dispatchMessage` nacks it once, immediately, under its
original routing key, never touching the queue's `retry` budget at all. So an
infrastructure failure that is not explicitly recovered is parked on its
first attempt exactly like a permanent domain error — `.recoverDefect((cause)
=> ErrAsync(new RetryableError(...)))` in the worked example above is not
decoration, it is what keeps "infrastructure comes back" true on this
transport. A queue's `retry: { mode: "ttl-backoff", maxRetries: 3 }` also
means **four** total attempts (the first, plus three retries) — do not read
it as the same number Temporal's `maximumAttempts: 3` names, which counts the
first attempt too.

## The drain, and the one deadline

`Serving.drain(signal)` calls `worker.close({ drainTimeoutMs: null })` —
cancel every consumer, let in-flight handlers finish so their acks land on a
still-open channel, then close — **raced against `signal`**, the kernel's own
deadline.

`drainTimeoutMs: null` is what makes this package simpler than `@btravstack/temporal`:
the library's own default drain timeout is 30 seconds, which would sit above
the kernel's 20-second default and quietly win, giving the process two
deadlines that could disagree. Telling the library to wait forever removes
the second one entirely — there is nothing here to keep in sync with
`StartOptions.drainTimeoutMs`, because there is nothing else counting. `stop()`
reuses whatever deadline `drain` armed, so a signal-driven shutdown never
waits twice; called on its own, with no drain having happened, there is no
deadline to race, and `stop()` waits on the worker's own close.

## What abandonment costs

When the kernel's deadline wins the race, the runtime returns and the
worker's `close()` call is still running underneath — polling has already
stopped, but nothing was dropped: the connection stays open and the
in-flight delivery's handler keeps running toward its own ack or nack in the
background, on the library's clock rather than the kernel's. The kernel is
released on time and reports the unit `abandoned`, which is honest about what
_it_ waited for, not about what became of the message.

Redelivery is a real property of the broker, but only once the connection
actually drops — which happens when the **process** exits, not when the
kernel's drain deadline does. A pod that survives past `drainTimeoutMs` and
into `stopping` before being SIGKILLed keeps the connection open the whole
time, so a delivery whose handler finishes during that window is acked or
nacked normally, same as any other; only a delivery whose handler is still
running when the process is actually killed gets redelivered. No in-process
test can tell these two outcomes apart — both leave `abandoned: 1` in the
kernel's own report — which is why this package's own suite pins only the
half it can observe: the prompt release, not the eventual disposition. See
`releasedBy`'s TSDoc in `src/amqp-runtime.ts` for the full reasoning.

## The unit boundary

One unit per **delivery**. `UnitMeta.id` is a minted `randomUUID()`, and
`traceId` is the publisher's `messageId` (falling back to `correlationId`,
then to the minted id).

A delivery tag looks like the obvious `id` and is not one: tags are
per-**channel** and restart at `1` after a reconnect, which
`amqp-connection-manager` performs silently underneath this worker — so two
deliveries on either side of a reconnect can carry the same tag.
`consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
caller pin their own `consumerTag`. Minting is the only form of the rule that
survives every case, the same answer `@btravstack/http` reaches per request.

## Writing a runtime

Two contracts a runtime owes the kernel, neither of them checkable, both
discharged here:

1. **The response must be flushed inside the unit.** A delivery's ack or
   nack happens inside `next()` — inside the unit `messageUnits` opened —
   because `amqp-contract`'s own dispatch settles it from the handler's
   returned `Result`. There is no seam for a late ack to land in.
2. **`UnitMeta.id` must be unique per unit unless a `traceId` is supplied.**
   A fresh `randomUUID()` per delivery and the publisher's own `messageId` as
   the correlation id — a caller cannot get either wrong by supplying a
   category where an identity was wanted.

## License

MIT
