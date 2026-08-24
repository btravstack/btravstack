---
title: Consume AMQP messages
description: Provide an amqp-contract's handlers as a di service, compose the consumer with AmqpModule, and decide ack, retry and dead-letter with the three-way split the transport actually has.
---

# Consume AMQP messages

> **How-to.** Run an [`amqp-contract`](https://github.com/btravstack/amqp-contract)
> worker under the kernel: handlers built from your own services, one unit per
> delivery, and a drain with exactly one deadline. For the package's full
> surface, see [`@btravstack/amqp`](/reference/amqp); for _why_ neither the
> kernel nor the starter maps a `Result` to ack/nack, see
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing).

You have a contract with a consumer on a queue, and a service that should
react to each message. What you write is the handlers record and a
composition root; the connection, the unit boundary and the release at the
kernel's deadline are the package's. Everything below is lifted from
`examples/order-amqp-worker`.

## Recipe

1. Implement the handlers with `AmqpHandlers(contract)(deps, arm)` —
   one plain function per consumer, typed by the contract.
2. Decide, per handler, what a domain `Err` and a `Defect` become
   (see the three-way split below).
3. Compose with `AmqpModule(name)({ contract, handlers, imports, provides, exports, needs })`.
4. `await runMain(OrderAmqpWorker)`; set `AMQP_URL` in the deployment.

## Step 1 — the handlers, as a provider

`AmqpHandlers(orderContract)` is di's `Provider(port)` on the starter's own
handlers port, typed for the contract (its service the record the contract
wants, `WorkerInferHandlers<typeof orderContract>`) — no class, no name: a
consumer serves one handlers record — so the next call declares what the
handlers need and closes over it. **Nothing is injected per message** — the middleware
the package installs opens the unit and calls `next()` unchanged:

A record covers **every** consumer and rpc the contract declares —
`orderContract` has two, `orderNotifications` and `orderAudit`, both reading
the one `orderChanged` event on their own queue:

<!-- doctest: prelude
import { Config } from "@btravstack/config";
import { AmqpConfig } from "@btravstack/amqp";
import { Provider, type ServiceOf } from "@btravstack/di";
import { Outbox, PlaceOrder } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import type { AsyncResult } from "unthrown";
import { OutboxRelay } from "../../outbox-relay.js";

// The two module-private helpers the outbox-relay excerpt leans on — the
// page shows the provider, not the whole file.
declare const tenantsOf: (value: string) => readonly TenantId[];
declare const startOutboxRelay: (
  outbox: ServiceOf<Outbox>,
  logger: ServiceOf<Logger>,
  options: { url: string; pollMs: number; tenants: readonly TenantId[] },
) => AsyncResult<ServiceOf<OutboxRelay>, RetryableError>;
import { currentUnit } from "@btravstack/core";
import { RetryableError } from "@amqp-contract/worker";
import { ErrAsync } from "unthrown";
-->

```ts
import { AmqpHandlers } from "@btravstack/amqp";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Logger } from "@btravstack/observability";
import { OkAsync } from "unthrown";

export const orderHandlers = AmqpHandlers(orderContract)(
  { logger: Logger },
  {
    sync: ({ logger }) => ({
      orderNotifications: (message) => {
        const { tenantId, id, payload } = message.payload;
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
      orderAudit: (message) => {
        const { tenantId, id, occurredAt, payload } = message.payload;
        logger.info("recording an order change", {
          tenantId,
          orderId: id,
          occurredAt,
          change: payload === null ? "removed" : "placed",
        });
        return OkAsync();
      },
    }),
  },
);
```

`examples/order-amqp-worker` composes these two consumers from a slice each
now, rather than in one function — see
[Split a worker into slices](/how-to/split-a-worker-into-slices) — but the
monolithic form above is unchanged, and right for a worker that has not
outgrown it.

## Step 2 — the three-way split

`amqp-contract`'s dispatch settles a delivery from the handler's `Result`, and
it is a **three-way** split, not two:

| The handler's `Result` is… | What happens                                                              | Decided by      |
| -------------------------- | ------------------------------------------------------------------------- | --------------- |
| `Ok`                       | ack                                                                       | `amqp-contract` |
| `Err(RetryableError)`      | routed by the queue's `retry` config (e.g. `ttl-backoff`, `maxRetries`)   | `amqp-contract` |
| `Err(NonRetryableError)`   | nack, straight to the dead-letter exchange                                | `amqp-contract` |
| a `Defect`                 | nacked **once, immediately**, to the dead-letter — never touching `retry` | `amqp-contract` |

The last row is the one to internalise. An unrecovered infrastructure failure
is parked on its first attempt exactly like a permanent domain error. **A
handler that wants "infrastructure comes back" recovers its own defects into a
`RetryableError` explicitly** (an alternative to `orderHandlers` above, not
a second provider next to it — the port is one, so one graph holds one
handlers provider):

```ts
import { AmqpHandlers } from "@btravstack/amqp";
import { NonRetryableError, RetryableError } from "@amqp-contract/worker";
import { TenantId } from "@btravstack/example-order-domain";
import { ErrAsync, OkAsync, P } from "unthrown";

export const placingHandlers = AmqpHandlers(orderContract)(
  { place: PlaceOrder },
  {
    sync: ({ place }) => ({
      orderNotifications: (message) =>
        place
          .execute(
            TenantId(message.payload.tenantId),
            message.payload.id,
            message.payload.payload?.quantity ?? 0,
          )
          .map(() => undefined)
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("InvalidQuantity"),
              P.tag("InvalidOrderId"),
              P.tag("DuplicateOrder"),
              (error) => new NonRetryableError(error._tag, error),
            ),
          )
          .recoverDefect((cause) =>
            ErrAsync(new RetryableError("placing the order failed", cause)),
          ),
      // Not the point of this example — a bare ack keeps `placingHandlers`
      // focused on the triage `PlaceOrder` needs.
      orderAudit: () => OkAsync(),
    }),
  },
);
```

The queue's policy is contract configuration the broker enforces — the
example's `order-notifications` queue declares
`retry: { mode: "ttl-backoff", maxRetries: 3 }` and a dead-letter exchange.
Read `maxRetries: 3` as **four** total attempts (the first plus three
retries), not the same number Temporal's `maximumAttempts: 3` names.

## Step 3 — the composition root

<!-- doctest: defer -->

```ts
import { Env } from "@btravstack/config";
import { AmqpModule } from "@btravstack/amqp";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  OrderApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger, observability } from "@btravstack/observability";

import { orderHandlers } from "./handlers.js";
import { outboxRelay, relayConfig } from "./outbox-relay.js";

export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
```

`AmqpModule` is `Module(name)({...})` plus `contract` and `handlers`: it
imports `amqp({ contract })`, provides the handlers and exports
`AmqpRuntime`. [`observability()`](/reference/observability) is the other
starter in that list — the `Logger` the handlers and the relay write to, bound
from `LOG_LEVEL`, JSON per line on stdout, every line carrying the delivery's
own unit. The record is checked against the contract at
`AmqpHandlers(contract)(…)` — a record missing a consumer, or naming one the
contract does not declare, fails to typecheck there rather than on the first
delivery, silently to the DLQ — and `handlers` is typed against the module's
own `contract`, so a provider built for another contract is refused here.

## Step 4 — `main.ts`

<!-- doctest: defer -->

```ts
import { runMain } from "@btravstack/core";

import { OrderAmqpWorker } from "./module.js";

await runMain(OrderAmqpWorker);
```

## Configuration and options

`amqp()` provides `AmqpRuntime` and `AmqpConfig` (`{ url }`), and needs the
handlers port. Options on `AmqpModule` and `amqp()` alike:

| Variable / option        | Default                 | Notes                                                                                        |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| `AMQP_URL` / `url`       | `amqp://127.0.0.1:5672` | `url` pins the broker (a test's container); a blank variable is a `ConfigInvalid`, exit `78` |
| `connectTimeoutMs`       | the library's `30s`     | how long `create` waits before an unreachable broker is a `RuntimeStartFailed`, exit `1`     |
| `connectionOptions`      | —                       | passed through to `TypedAmqpWorker.create`                                                   |
| `defaultConsumerOptions` | —                       | likewise                                                                                     |

Once consuming, the runtime publishes `AmqpInfo` — `{ queues }`, every queue
the contract's consumers and RPCs drain — on `Serving.info`, read through
`runtimeInfo()`.

## One unit per delivery

`UnitMeta.id` is a minted `randomUUID()` per delivery; `traceId` is the
publisher's `messageId`, falling back to `correlationId`, then to the minted
id. A delivery tag is not used as the id on purpose: tags are per-channel and
restart at `1` after the silent reconnects `amqp-connection-manager` performs.
An adapter reads the trace id from `currentUnit()`.

## Honouring the drain deadline

The middleware calls `next()` unchanged, so a handler has no parameter to
receive the unit's `AbortSignal` through: `currentUnit()?.signal` is the only
route to it, and it is aborted at the kernel's `drainTimeoutMs`.

<!-- doctest: skip — an object-property excerpt, not a statement: the handler in situ is the `orderHandlers` fence above, and the full slice form is on /how-to/split-a-worker-into-slices -->

```ts
orderNotifications: (message) => {
  const { id, payload } = message.payload;
  if (currentUnit()?.signal.aborted === true) {
    return ErrAsync(
      new RetryableError(
        `the drain deadline passed before order ${id} was notified`,
      ),
    );
  }
  // …
};
```

A `RetryableError` leaves the delivery **un-acked**, so the broker hands it to
the next worker — the transport's own answer to "this process stopped waiting".
There is no cancellation to defer to here: AMQP has none, and a redelivery is
recovery rather than cancellation.

## The drain: one deadline

`Serving.drain(signal)` calls `worker.close({ drainTimeoutMs: null })` —
cancel every consumer, let in-flight handlers finish so their acks land on a
still-open channel — **raced against the kernel's signal**. `null` is
deliberate: the library's own default drain timeout is 30 s, above the
kernel's 20 s default, and would quietly win. Telling the library to wait
forever leaves the kernel's `drainTimeoutMs` as the only clock in the process.

::: info When the deadline wins
The kernel reports the unit `abandoned` (exit `2`), but nothing was dropped:
the connection stays open and the handler runs on toward its own ack or nack.
Redelivery happens only once the connection actually drops — when the
process exits, not when the drain deadline passes.
:::

## The publishing half: an outbox relay as a resource

The example's producer is not a runtime. `outbox-relay.ts` provides
`OutboxRelay` with `acquire`/`release`, so di starts it as the graph builds
and stops it when the application scope closes — after the consumer stopped,
which is fine: rows published during the drain window are safer out than left
to the next boot. Its poll interval is a config slice of its own:

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

It reads `AmqpConfig` — the broker the starter bound — and shares the
worker's connection lease through `@amqp-contract/core`'s pool. A broker it
cannot reach is the modeled `BrokerUnreachable`, a startup `Err` and exit `1`.

`OUTBOX_TENANTS` is a comma-separated list with **no default**, and
`tenantsOf` splits it and claims the `TenantId` brand once — the relay is the
one caller with no request, delivery or activity behind it, so its tenants are
deployment configuration rather than something to read off an ambient record.
The sweep then goes tenant by tenant, so one tenant's backlog cannot starve
another's.

## See also

- [`@btravstack/amqp`](/reference/amqp) — options, ports, `AmqpInfo`.
- [Split a worker into slices](/how-to/split-a-worker-into-slices) — several
  consumers, one handler per consumer, composed at the root.
- [Order AMQP worker](/examples/order-amqp-worker) — the outbox pattern end to end, against a real RabbitMQ.
- [Manage a resource's lifetime](/how-to/manage-a-resource) — `acquire`/`release`, as the relay uses it.
- [Configure from the environment](/how-to/configure-from-the-environment) — `AMQP_URL` and `OUTBOX_POLL_MS`.
