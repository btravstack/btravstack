---
title: Order AMQP worker example
description: The broadcast deployment — two subscriber slices composed by AmqpHandlers over the order contract, a transactional outbox relayed onto RabbitMQ by a resourceful provider with its own RelayConfig and a modeled BrokerUnreachable, a tombstone behind every cancellation, and a real broker container per run.
---

<!-- doctest: prelude
import { AmqpConfig, AmqpHandler, AmqpHandlers, AmqpModule } from "@btravstack/amqp";
import { RetryableError } from "@amqp-contract/worker";
import { Config, Env } from "@btravstack/config";
import { currentUnit } from "@btravstack/core";
import { Provider, type ServiceOf } from "@btravstack/di";
import { Logger, observability } from "@btravstack/observability";
import { ErrAsync, OkAsync, TaggedError } from "unthrown";
import { TenantId } from "@btravstack/example-order-domain";
import {
  OrderApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { OutboxRelay } from "../../outbox-relay.js";
import { piece as orderAudit } from "../../slices/audit/handler.js";
import { slice as AuditSlice } from "../../slices/audit/module.js";
import { slice as NotificationsSlice } from "../../slices/notifications/module.js";
declare const startOutboxRelay: (
  outbox: ServiceOf<Outbox>,
  logger: ServiceOf<Logger>,
  options: { url: string; pollMs: number; tenants: readonly TenantId[] },
) => AsyncResult<ServiceOf<OutboxRelay>, BrokerUnreachable>;
import type { AsyncResult } from "unthrown";
-->

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
)(
  { logger: Logger },
  {
    sync:
      ({ logger }) =>
      (message) => {
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
  },
);
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
directly. Dropping either import leaves that piece's port unmet: a runtime
`WiringDefect`, not a compile error.

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
    tenants: Config.string("OUTBOX_TENANTS"),
  }),
);
```

`OUTBOX_POLL_MS=0` is rejected — a relay that never sleeps is a busy loop —
and so is anything above a minute; either is a `ConfigInvalid`, `startFailed`
and exit `78`. `OUTBOX_TENANTS` has **no default**, deliberately: the relay
runs outside any unit, so it cannot read a tenant off the ambient record the
way every other adapter does, and "whatever is in the table" is how one
deployment starts broadcasting another's facts. It is a comma-separated list,
and `tenantsOf` is the one place this deployment claims the `TenantId` brand
from configuration rather than from a contract:

```ts
const tenantsOf = (value: string): readonly TenantId[] =>
  value
    .split(",")
    .map((tenant) => tenant.trim())
    .filter((tenant) => tenant !== "")
    .map(TenantId);
```

Naming the tenants is also how a relay is **sharded** — two deployments, half
the list each, and neither can starve the other's backlog. The sweep then
goes tenant by tenant, `outbox.pending(tenantId, BATCH)` at a time.

A broker the relay cannot reach is modeled rather than left the
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
  {
    outbox: Outbox,
    logger: Logger,
    broker: AmqpConfig,
    config: relayConfig.port,
  },
  {
    acquire: ({
      outbox,
      logger,
      broker: { url },
      config: { pollMs, tenants },
    }) =>
      startOutboxRelay(outbox, logger, {
        url,
        pollMs,
        tenants: tenantsOf(tenants),
      }),
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
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    observability(),
  ],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
```

The root is now a list of slices plus what no slice owns: the vertical the
outbox relay writes from (`OrderApplicationModule` / `OrderPersistenceModule`
— the relay's own, not either subscriber's), the starter over `orderHandlers`,
[`observability()`](/reference/observability) for the `Logger` every
subscriber and the relay write to — `LOG_LEVEL`, JSON per line on stdout,
every consumer line correlated with the delivery's own unit — and both
halves of the outbox pattern in one graph. The exports are the writer's
surface — what a writer in the same process places and cancels through, and
what the specs tap. `main.ts` is `await runMain(OrderAmqpWorker);`.

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
straight, both from [`@btravstack/amqp`](/reference/amqp): `maxRetries: 3` is
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

<!-- doctest: skip — an excerpt of src/test-fixtures.ts, which the gate compiles and runs -->

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
top of it — `tapped(recording, [PlaceOrder, OrderRepository, Outbox])`: the
writer the spec places orders through and the outbox it asserts against are
the very instances the running app uses, not fresh ones, while neither
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
    OrderApplicationModule,
    OrderPersistenceModule,
    observability(),
    amqp({ contract: orderContract }),
  ],
  exports: [AmqpRuntime, PlaceOrder, Logger],
});

// @ts-expect-error — the module's needs channel carries the handlers port, which nothing provides.
const _missingHandlers = start(HandlerlessAmqp, options);
```

Two different diagnostics, worth telling apart. The first is `start`'s marker:
the module argument fails to match
`Module<…> & "NO RUNTIME — the module exports no port declared over RuntimePort"`,
and the sentence is the last line. The second is the `Needs` channel: the
handlers port is owed by `amqp()`, an **import** — so di's
[declaration gate](/explanation/modules-and-privacy) has nothing to say, an
import's needs travel without being restated, and `start`'s `module` parameter
takes only `Scope | Env`, so what prints is
`Type 'HandlersInstanceOf<…>' is not assignable to type 'Env | Scope'` — wide,
because the contract expands, but ending on
`Type '"AmqpHandlers"' is not assignable to type '"@di/Scope"'`, which names the
port. Neither is di's `UNSATISFIED DEPENDENCIES` dependency gate.

## Where to go next

- The other two deployments: [Order API (HTTP)](/examples/order-api),
  [Order Temporal worker](/examples/order-temporal-worker).
- The package: [`@btravstack/amqp`](/reference/amqp); the task:
  [Consume AMQP messages](/how-to/consume-amqp-messages).
