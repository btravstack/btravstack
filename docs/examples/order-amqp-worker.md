---
title: Order AMQP worker example
description: The broadcast deployment — AmqpHandlers and AmqpModule over the order contract, a transactional outbox relayed onto RabbitMQ by a resourceful provider with its own RelayConfig and a modeled BrokerUnreachable, a tombstone behind every cancellation, and a real broker container per run.
---

# Order AMQP worker

[`examples/order-amqp-worker`](https://github.com/btravstack/start/tree/main/examples/order-amqp-worker)
— the broadcast deployment: [the order application](/examples/order-application)
telling everyone what happened, served by [`@btravstack/amqp`](/reference/amqp).

```sh
pnpm turbo run test --filter=@btravstack/example-order-amqp-worker
```

::: warning Docker required
The suite runs against a **real RabbitMQ**: `@amqp-contract/testing` boots
one container per vitest run (`globalSetup`) and hands each test its own
vhost. Measured: about 15.5 s cold (image pull included), about 5 s warm. A
broker's routing is the broker's behaviour, and nothing in memory could stand
in for it.
:::

## The pattern, in three places

**The write** is `OrderRepository.save` in `order-infrastructure`: the order
row and its `OutboxMessage` row commit in one `$tryTransaction`, and `remove`
writes a **tombstone** — an event with a `null` payload — the same way. There
is no "publish after save" to forget and no window where the order exists but
the fact of it is lost.

**The relay** is `outbox-relay.ts`: sweep the outbox in commit order, publish
each row to the `orders` exchange, mark what the broker confirmed.

**The consumer** is one plain function on the contract's `order-notifications`
queue — deliberately the least interesting part, because a broadcast's
publisher does not know it exists.

## The handlers: a service from `Logger`

`AmqpHandlers(orderContract)` is di's `Provider(port)` on the starter's own
handlers port, typed for the contract — its service the record the contract
wants, `WorkerInferHandlers<OrderContract>`, no injected context; no class, no
name, since a consumer serves one handlers record — so the handler is built
from what it declares like any use case:

```ts
export const orderHandlers = AmqpHandlers(orderContract)([Logger], {
  sync: (logger) => ({
    orderChanged: (message) => {
      const { id, payload } = message.payload;
      logger.info(
        payload === null
          ? `order ${id} is gone — notifying`
          : `order ${id} placed — notifying (${payload.quantity} items)`,
      );
      return OkAsync();
    },
  }),
});
```

The `payload === null` branch is the whole point of the envelope: one handler,
one ordered stream, and a reader keeping its own copy upserts on a payload and
drops on a tombstone. There is no second message type to declare or keep
ordered against this one. The handler has no domain errors to triage — a
placement's `Err` never crosses the broker, only the committed fact does —
which is why this deployment is absent from the `Err` table on the
[overview](/examples/).

## The relay: a resourceful provider with its own config

The relay's one piece of configuration is a slice of this deployment's own,
so `Config.provider("RelayConfig")` mints the port and nothing else ever
names it:

```ts
export const relayConfig = Config.provider("RelayConfig")(
  Config.object({
    pollMs: Config.integer("OUTBOX_POLL_MS", {
      min: 1,
      max: 60_000,
      default: 200,
    }),
  }),
);
```

`OUTBOX_POLL_MS=0` is rejected — a relay that never sleeps is a busy loop —
and so is anything above a minute; either is a `ConfigInvalid`, `startFailed`
and exit `78`. A broker the relay cannot reach is modeled rather than left the
defect `TypedAmqpClient.create` reports it as, because an operator can act on
it:

```ts
export class BrokerUnreachable extends TaggedError("BrokerUnreachable")<{
  readonly url: string;
  readonly cause: unknown;
}> {}
```

so `runMain` exits `1`, a startup `Err`, not the `70` a defect earns. The
relay itself is acquired as the graph builds and released when the
application scope closes:

```ts
export const outboxRelay = Provider(OutboxRelay)(
  [Outbox, Logger, AmqpConfig, relayConfig.port],
  {
    acquire: (outbox, logger, { url }, { pollMs }) =>
      startOutboxRelay(outbox, logger, { url, pollMs }),
    release: (running) => running.stop().get(),
  },
);
```

It depends on `AmqpConfig` — the broker `amqp()` bound — so the relay and the
consumer read one `AMQP_URL`; it creates its own `TypedAmqpClient` because a
transport connection is the transport's own, and it is not a second TCP
connection either, since `@amqp-contract/core` pools by URL and
reference-counts leases. Nothing resolves `OutboxRelay`, and nothing needs to:
a resourceful provider exists to be started and stopped. The loop is
**at-least-once** by design — a crash between publish and `markPublished`
re-publishes on the next sweep — and it triages all three channels per event:
published → mark; a `MessageValidationError` → left pending, logged; a defect
(broker down mid-flight) → left pending, retried next sweep.

The ordering is worth stating: the relay starts **before** the consumer (as
the graph builds) and stops **after** it (when the scope closes, not inside
the runtime's `stop`). `drain` stays the consumer's alone — draining means
"stop taking new work", and the relay's work is outbound.

## The composition root, and the process

```ts
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [ApplicationModule, PersistenceModule],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
```

The same application pair, the starter over `orderHandlers`, and both halves
of the outbox pattern in one graph. The exports are the writer's surface —
what a writer in the same process places and cancels through, and what the
specs tap. `main.ts` is `await runMain(OrderAmqpWorker);`.

## Retry and dead-letter live in the contract

`order-amqp-contract` gives the subscriber queue its policy, and the broker
enforces it:

```ts
const notifications = defineQueue("order-notifications", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});
```

Naming a failure decides what the platform does next — the sharper form of
the claim the Temporal contract makes with `nonRetryable`. Two things to keep
straight, both from [`@btravstack/amqp`](/reference/amqp): `maxRetries: 3` is
**four** total attempts, not Temporal's three; and a handler's `Defect` is
nacked once, straight to the dead-letter exchange, never touching that budget
— so a handler that wants "infrastructure comes back" recovers its own
defects into a `RetryableError`. `externalConsumers: true` on the dead letter
is required, not decorative: the contract's routability check rejects a DLX
nothing binds to, and parking is this queue's point.

## The specs: against a real broker

`test-fixtures.ts` extends `@amqp-contract/testing`'s `it`, whose
`amqpConnectionUrl` is this test's own vhost, with `@btravstack/testing`'s
`boot: bootFixture()` and a `serve` over it that boots the same
`OrderAmqpWorker` `main.ts` does with
`env: { AMQP_URL: amqpConnectionUrl, OUTBOX_POLL_MS: "25" }` — the poll tight
because every spec waits on real broker round trips:

```ts
await use(async (module, options) => {
  const app = boot(module, { env, ...options });
  // `runtimeInfo()` resolves once the worker is consuming — await it here
  // so the caller's test body never races the worker's own startup.
  await app.runtimeInfo();
  return app;
});
```

Every app is stopped by `boot`'s teardown when the test ends. The `tapped`
fixture is `tapped(OrderAmqpWorker, [PlaceOrder, OrderRepository, Outbox,
Logger])`: the writer the spec places orders through, the outbox it asserts
against and the logger the consumer writes to — the very instances the
running app uses, not fresh ones.

Five specs, each a fact crossing the outbox, the broker and the queue: a
committed write comes back as the consumer's notification, with the write
side never having spoken AMQP; relayed events are marked published exactly
once; two writes arrive in commit order; a cancellation arrives as a
tombstone **after** its placement; and a foreign queue — bound to the same
`orders` exchange by the test, declared by nothing in the contract — receives
the same event:

```ts
const [message] = await waitForMessages({ count: 1, timeoutMs: 5_000 });
expect(JSON.parse(String(message?.content))).toEqual({
  kind: "order",
  id: "o-5",
  occurredAt: expect.any(String),
  payload: { quantity: 4 },
});
```

That last one is the broadcast working as intended: the publisher addressed
an exchange, never a consumer.

## The gate

`needs-gate.test-d.ts` pins `NO RUNTIME`, and di's gate spelled with the
`amqp()` primitive — the sugar cannot leave the handlers out, which is what it
is for:

```ts
const HandlerlessAmqp = Module("HandlerlessAmqp")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    amqp({ contract: orderContract }),
  ],
  exports: [AmqpRuntime, PlaceOrder, Logger],
});

// @ts-expect-error — the module's needs channel carries the handlers port, which nothing provides.
const _missingHandlers = start(HandlerlessAmqp, options);
```

## Where to go next

- The other two deployments: [Order API (HTTP)](/examples/order-api),
  [Order Temporal worker](/examples/order-temporal-worker).
- The package: [`@btravstack/amqp`](/reference/amqp); the task:
  [Consume AMQP messages](/how-to/consume-amqp-messages).
