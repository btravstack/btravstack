---
title: Order AMQP worker example
description: The broadcast deployment — two subscriber slices composed by AmqpHandlers over the order contract, a transactional outbox relayed onto RabbitMQ by @btravstack/outbox through a publisher of the deployment's own contract with a modeled BrokerUnreachable, a tombstone behind every cancellation, and a real broker container per run.
---

<!-- doctest: prelude
import { TypedAmqpClient } from "@amqp-contract/client";
import { AmqpConfig, AmqpHandler, AmqpHandlers, AmqpModule } from "@btravstack/amqp-worker";
import { RetryableError } from "@amqp-contract/worker";
import { currentUnit, Logger, Tracer } from "@btravstack/core";
import { Port, Provider, type ServiceOf } from "@btravstack/di";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OutboxPublisher, OutboxStore, outbox } from "@btravstack/outbox";
import { ErrAsync, OkAsync, P, TaggedError } from "unthrown";
import { OrderDatabase, OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { MessageUnitModule } from "../../message-unit.js";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { orderAudit } from "../../slices/audit/handler.js";
import { AuditSlice } from "../../slices/audit/module.js";
import { NotificationsSlice } from "../../slices/notifications/module.js";
-->

# Order AMQP worker

[`examples/order-amqp-worker`](https://github.com/btravstack/btravstack/tree/main/examples/order-amqp-worker)
— the broadcast deployment: [the order application](/examples/order-application)
telling everyone what happened, served by [`@btravstack/amqp-worker`](/reference/amqp-worker).

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

**The relay** is [`@btravstack/outbox`](/reference/outbox)'s `outbox()`: claim
each tenant's pending rows, publish them in commit order through the
deployment's own `OutboxPublisher`, mark what the broker confirmed. The one
file this deployment writes for it is `outbox-publisher.ts`.

**The two subscribers** are one plain function each, on the contract's
`order-notifications` and `order-audit` queues — deliberately the least
interesting part, because a broadcast's publisher does not know either
exists.

## Two slices, one modulith

`order-amqp-contract` declares two consumers of the one `orderChanged`
publisher — `orderNotifications` and `orderAudit` — keyed for the
**subscriber**, not the event: two readers of one fact, not two facts. Each
lives in its own slice, `src/slices/notifications/` and `src/slices/audit/`,
the same shape [`order-api`](/examples/order-api) uses for its HTTP
controllers, but **thinner**: neither slice imports a vertical. A subscriber
reacts to a fact somebody else already committed, so it owns no domain and no
persistence — that is the honest shape for this transport, not a weaker
version of the HTTP one. What each slice still declares for itself is the
ports its own handler calls.

`AmqpHandler(contract, key)` mints one piece per consumer — no port class, no
name, since the contract key IS the port's name:

<!-- doctest: group=order-amqp-worker -->

```ts
export const orderNotifications = AmqpHandler(
  orderContract,
  "orderNotifications",
)({
  inject: { logger: Logger },
  sync:
    ({ logger }) =>
    ({ input: message }) => {
      const { tenantId, id, payload } = message.payload;
      if (currentUnit()?.signal.aborted === true) {
        return ErrAsync(
          new RetryableError(
            `the drain deadline passed before order ${id} was notified`,
          ),
        );
      }
      logger.info(
        payload === null
          ? "order gone — notifying"
          : "order placed — notifying",
        {
          tenantId,
          orderId: id,
          ...(payload === null ? {} : { quantity: payload.quantity }),
        },
      );
      return OkAsync();
    },
});
```

The audit slice is the same shape over `"orderAudit"`, minus the deadline
guard — it keeps writing through the drain window rather than leaving a
delivery un-acked, which is the point of having two: a notification for a
delivery nobody is waiting on is not worth sending, but an audit line for one
already in hand still is. What a slice answers when the kernel stops waiting
is the slice's own business.

The root composes both pieces into the one record the starter needs:

```ts
export const orderHandlers = AmqpHandlers(orderContract)([
  orderNotifications,
  orderAudit,
]);
```

keyed by the contract's own consumer names, so a consumer with no piece is a
compile error and two pieces claiming one key are di's duplicate-provider
defect at build. `orderHandlers`'s pieces are the composed provider's own
`deps`, and di's `flatten` discovers providers only through a module's
`imports` / `provides`, never through a provider's `deps` — so the root
**imports both slice modules**, `NotificationsSlice` and `AuditSlice`, even
though nothing in the root names `orderNotifications` or `orderAudit`
directly. That still fails to compile if forgotten: `AmqpHandlers` declares
each piece's port as one of its **own** `deps`, so a missing import is an
undeclared need at the `AmqpModule(...)` call, refused with the exact port
named — `pnpm typecheck` catches it, not a runtime `WiringDefect`.

The `payload === null` branch is the whole point of the envelope: one handler,
one ordered stream, and a reader keeping its own copy upserts on a payload and
drops on a tombstone. There is no second message type to declare or keep
ordered against this one. Neither handler has domain errors to triage — a
placement's `Err` never crosses the broker, only the committed fact does —
which is why this deployment is absent from the `Err` table on the
[overview](/examples/).

The notifier's `currentUnit()?.signal` guard is the deployment's one kernel
touchpoint, and it is how a handler honours the drain deadline at all:
`messageUnits` calls `next()` unchanged, so there is no parameter to receive a
signal through and the ambient record is the only route to it. Answering a
`RetryableError` leaves the delivery **un-acked**, so the broker hands it to
the next worker rather than this one finishing work nobody is waiting for.
See [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit).

## The relay: the package's, and the one half it cannot own

The loop, the claim and the table are [`@btravstack/outbox`](/reference/outbox)'s.
`OrderPersistenceModule` provides its `OutboxStore` over this application's
table — `prismaOutboxStore(db, { schema: "orders" })` — and `outbox()` reads
`OUTBOX_TENANTS` and `OUTBOX_POLL_MS` itself. What publishing a row MEANS is
the one thing the package cannot know, so it is this deployment's: a client of
its own contract, and an `OutboxPublisher` over it.

A broker the client cannot reach is modeled rather than left the defect
`TypedAmqpClient.create` reports it as, because an operator can act on it:

```ts
export class BrokerUnreachable extends TaggedError("BrokerUnreachable")<{
  readonly url: string;
  readonly cause: unknown;
}> {}
```

so `runMain` exits `1`, a startup `Err`, not the `70` a defect earns. The
client is a resourceful provider of its own, so the scope closing is what
closes it:

```ts
class OrderAmqpClient extends Port("OrderAmqpClient")<
  TypedAmqpClient<typeof orderContract>
> {}

export const orderAmqpClient = Provider(OrderAmqpClient)({
  inject: { broker: AmqpConfig },
  acquire: ({ broker: { url } }) =>
    TypedAmqpClient.create({ contract: orderContract, urls: [url] }).mapErrCases(
      (matcher) =>
        matcher.with(
          P.tag("@amqp-contract/ConnectionError"),
          (cause) => new BrokerUnreachable({ url, cause }),
        ),
    ),
  release: (client) => client.close().get(),
});
```

It depends on `AmqpConfig` — the broker `amqp()` bound — so the publisher and
the consumer read one `AMQP_URL`; it is not a second TCP connection either,
since `@amqp-contract/core` pools by URL and reference-counts leases. The
publisher turns an outbox row into the contract's envelope:

```ts
export const orderPublisher = Provider(OutboxPublisher)({
  inject: { client: OrderAmqpClient },
  sync: ({ client }): ServiceOf<OutboxPublisher> => ({
    publish: (message) =>
      OkAsync()
        .map(() =>
          message.payload === null
            ? null
            : (JSON.parse(message.payload) as { readonly quantity: number }),
        )
        .flatMap((payload) =>
          client.publish("orderChanged", {
            eventId: message.id,
            tenantId: message.tenantId,
            kind: message.kind as "order",
            id: message.subjectId,
            occurredAt: message.occurredAt.toISOString(),
            payload,
          }),
        ),
  }),
});
```

Any `Err` it answers — a `MessageValidationError`, a `PublishError` from a
broker that is down or nacking — leaves the row pending, and the relay stops
that tenant's batch there so a later fact never overtakes it, backs off and
tries again. Every claim and publish is reported to `Observers`, so the
`otel()` composed below counts and times them and writes the error line; a
success writes nothing. A tenant falling behind — a message refused forever,
say — turns the `outbox` component of `/healthz` unhealthy once its oldest
pending row is older than `OUTBOX_MAX_LAG_MS`.

The relay is **at-least-once**: a crash between a publish and its mark
re-publishes on the next claim, as does a claiming session the database ends
mid-batch. What it rules out is replicas racing for one table's rows: a tenant
is held by one relay while its claiming session lives, under a
transaction-scoped advisory lock, and skipped by the rest, so a tenant's
committed facts go out in outbox
order. Outbox order is not commit order, so a subject's order rests on its own
row: `save` writes the outbox row after the insert and `remove` after the
delete, and a second write about one order cannot take its id until the first
has committed. A subscriber deduplicates a re-delivery on `eventId`, the outbox
row's id.

`OUTBOX_TENANTS` has **no default**, deliberately: the relay runs outside any
unit, so there is no tenant to read off anything, and "whatever is in the
table" is how one deployment starts broadcasting another's facts. Naming the
tenants is also how relays are **sharded**.

The ordering is worth stating: the relay starts **before** the consumer (as
the graph builds) and stops **after** it (when the scope closes, not inside
the runtime's `stop`), and before the client it publishes through, which di
releases in reverse order of acquisition. `drain` stays the consumer's alone —
draining means "stop taking new work", and the relay's work is outbound.

## The composition root, and the process

```ts
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    observability(),
    otel(),
    outbox(),
  ],
  provides: [orderAmqpClient, orderPublisher],
  // The worker forks this once per delivery, after the message is validated —
  // which is where the envelope's `tenantId` becomes the fork's `Tenant`.
  unit: { message: MessageUnitModule },
  // Everything the fork reads out of the application scope, and the store a
  // spec reads the outbox back through.
  exports: [OutboxStore, OrderDatabase, Logger, Tracer],
});
```

The root is now a list of slices plus what no slice owns: the outbox store and
the one Prisma client behind it (`OrderPersistenceModule` — the relay's own,
not either subscriber's), the starter over `orderHandlers`,
[`observability()`](/reference/observability) for the `Logger` every
subscriber writes to — `LOG_LEVEL`, one line per call, every consumer line
correlated with the delivery's own unit — the relay, and the publisher it
relays through: both halves of the outbox pattern in one graph.
`MessageUnitModule` is the per-delivery fork: it names
`AmqpMessage(orderContract)` in its `needs`, which the worker seeds, and turns
the envelope's `tenantId` into `Tenant` once, so both handlers read
`context.unit.tenant` rather than the payload. The exports are what the fork
and the specs read out of the application scope; `PlaceOrder` is not among
them, because nothing at the root can build a tenant-bound repository. The real
root passes `observability({ sink: logSink })`, where `logSink` is `pinoSink`
over one pino instance, and `main.ts` hands the kernel's own events to the
same sink:
`await runMain(OrderAmqpWorker, { onEvent: kernelEvents(createLogger(logSink)) });`.

## Retry and dead-letter live in the contract

`order-amqp-contract` gives each subscriber queue its own policy, and the
broker enforces it:

<!-- doctest: skip — quotes examples/order-amqp-contract/src/contract.ts, which its own workspace compiles -->

```ts
const notifications = defineQueue("order-notifications", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});

const audit = defineQueue("order-audit", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});
```

Naming a failure decides what the platform does next — the sharper form of
the claim the Temporal contract makes with `nonRetryable`. Two things to keep
straight, both from [`@btravstack/amqp-worker`](/reference/amqp-worker): `maxRetries: 3` is
**four** total attempts, not Temporal's three; and a handler's `Defect` is
nacked once, straight to the dead-letter exchange, never touching that budget
— so a handler that wants "infrastructure comes back" recovers its own
defects into a `RetryableError`. `externalConsumers: true` on the dead letter
is required, not decorative: the contract's routability check rejects a DLX
nothing binds to, and parking is the point for both queues. Each queue's
policy is its own — they carry the same values today, but nothing ties them
together; a slower or more critical subscriber could tune its own
independently.

## The specs: against a real broker

`test-fixtures.ts` extends `@amqp-contract/testing`'s `it`, whose
`amqpConnectionUrl` is this test's own vhost, with `@btravstack/testing`'s
`boot: bootFixture()` and a `serve` over it that boots the same
`OrderAmqpWorker` `main.ts` does with
`env: { AMQP_URL: amqpConnectionUrl, OUTBOX_POLL_MS: "25", OUTBOX_TENANTS:
tenant }` — the poll tight because every spec waits on real broker round
trips, and the tenant this test's alone, so the relay sweeps its rows and
nobody else's:

<!-- doctest: skip — an excerpt of src/__tests__/test-fixtures.ts, which the gate compiles and runs -->

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
fixture composes the root's own shape — both slices imported, same as
`OrderAmqpWorker` — with `observability({ sink })` and taps the services on
top of it — `tapped(recording, [OrderDatabase, Logger, OutboxStore])`: the `writer`
fixture composes a per-tenant scope over that very client, so the rows the
spec commits are the ones the relay sweeps, while neither
subscriber's own lines need a tap at all — the sink hands them over as `Line`
values, so the assertions read `{ message, orderId, quantity }` rather than a
formatted sentence.

Six specs, each a fact crossing the outbox, the broker and one or both
queues: a committed write comes back as the notifier's notification, with the
write side never having spoken AMQP; relayed events are marked published
exactly once; two writes arrive in commit order; a cancellation arrives as a
tombstone **after** its placement; one write reaches both subscribers — a
broadcast, not a work queue; and a foreign queue — bound to the same `orders`
exchange by the test, declared by nothing in the contract — receives the same
event too:

<!-- doctest: skip — an assertion excerpt of src/amqp-runtime.spec.ts, which the gate runs -->

```ts
const [message] = await waitForMessages({ count: 1, timeoutMs: 5_000 });
expect(JSON.parse(String(message?.content))).toEqual({
  kind: "order",
  id: "0199a1e0-0000-7000-8000-000000000005",
  occurredAt: expect.any(String),
  payload: { quantity: 4 },
});
```

That last one is the broadcast working as intended: the publisher addressed
an exchange, never a consumer.

## The gate

`needs-gate.test-d.ts` pins `NO RUNTIME — …`, and the unmet-need refusal
spelled with the `amqp()` primitive — the sugar cannot leave the handlers out,
which is what it is for:

<!-- doctest: skip — quotes src/needs-gate.test-d.ts, the real gate for the unmet-handlers arm -->

```ts
const HandlerlessAmqp = Module("HandlerlessAmqp")({
  imports: [
    OrderPersistenceModule,
    observability(),
    amqp({ contract: orderContract }),
  ],
  exports: [AmqpRuntime, OutboxStore, Logger],
});

// @ts-expect-error — the module's needs channel carries the handlers port, which nothing provides.
const _missingHandlers = start(HandlerlessAmqp, options);
```

Two arms of the same marker, worth telling apart. The first is `NO RUNTIME`:
the module argument fails to match
`Module<…> & "NO RUNTIME — the module exports no port declared over RuntimePort"`,
and the sentence is the last line. The second is the `Needs` channel: the
handlers port is owed by `amqp()`, an **import** — so di's
[declaration gate](/explanation/modules-and-privacy) has nothing to say, since
an import's needs travel without being restated — and `start` answers it in
di's own words, ending on

```text
{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": "AmqpHandlers" }
```

The line is wide, because the contract expands into the module type either
way; what fits is the part that matters, since the port is named by its **id**
rather than by `HandlersInstanceOf<…>`.

## Where to go next

- The other two deployments: [Order API (HTTP)](/examples/order-api),
  [Order Temporal worker](/examples/order-temporal-worker).
- The package: [`@btravstack/amqp-worker`](/reference/amqp-worker); the task:
  [Consume AMQP messages](/how-to/consume-amqp-messages).
