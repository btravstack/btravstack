# @btravstack/amqp-worker

> The **consuming half** of AMQP for [`@btravstack/core`](../core) — publishing
> belongs to `@amqp-contract/client`, which the outbox relay in
> `examples/order-amqp-worker` uses directly. An
> [`amqp-contract`](https://github.com/btravstack/amqp-contract) worker under
> the kernel's lifecycle — one unit per delivery, and a drain with exactly one
> deadline, the kernel's own.

📖 **[Documentation](https://btravstack.github.io/btravstack/how-to/consume-amqp-messages)** ·
[Reference](https://btravstack.github.io/btravstack/reference/amqp-worker) ·
[API Reference](https://btravstack.github.io/btravstack/api/amqp-worker/)

```sh
pnpm add @btravstack/amqp-worker @btravstack/core @btravstack/config @btravstack/di unthrown \
  @amqp-contract/worker @opentelemetry/api
```

All six are peer dependencies — install them (`@opentelemetry/api` because
`@amqp-contract/worker` itself peers on it). Node `>=22`.

## A worked example

<!-- doctest: prelude
import { NonRetryableError, RetryableError } from "@amqp-contract/worker";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { PlaceOrder } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { Module } from "@btravstack/di";
import { OrderApplicationModule, OrderRepository, Outbox } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";

// The application module the README's composition imports — the orders
// vertical plus its persistence, as an application would compose it.
const AppModule = Module("App")({
  imports: [OrderApplicationModule, OrderPersistenceModule, observability(), otel()],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
-->

```ts
import { Env } from "@btravstack/config";
import { AmqpHandlers, AmqpModule } from "@btravstack/amqp-worker";
import { runMain, Logger } from "@btravstack/core";
import { ErrAsync, OkAsync, P } from "unthrown";

// The handlers, as a service: one entry per consumer the contract declares,
// built by di from the use cases it lists — no injected context — on the
// starter's own handlers port, typed by the contract (a consumer serves one
// handlers record, so there is nothing to name).
const orderHandlers = AmqpHandlers(orderContract)(
  { placeOrder: PlaceOrder },
  {
    sync: ({ placeOrder }) => ({
      orderNotifications: (message) =>
        placeOrder
          .execute(
            TenantId(message.payload.tenantId),
            message.payload.id,
            message.payload.payload?.quantity ?? 0,
          )
          .map(() => undefined)
          // A modeled domain error is permanent: dead-letter it, no retry.
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("InvalidQuantity"),
              P.tag("InvalidOrderId"),
              P.tag("DuplicateOrder"),
              (error) => new NonRetryableError(error._tag, error),
            ),
          )
          // Infrastructure failing is not: recover the defect into a retry.
          .recoverDefect((cause) =>
            ErrAsync(new RetryableError("placing the order failed", cause)),
          ),
      // Every consumer the contract declares must be covered — an uncovered
      // key is refused at this call, not on the first delivery.
      orderAudit: () => OkAsync(undefined),
    }),
  },
);

const Worker = AmqpModule("Worker")({
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [AppModule],
});

await runMain(Worker);
```

`AmqpModule` imports the starter — `AmqpRuntime`, `AmqpConfig` bound from
`AMQP_URL` (default `amqp://127.0.0.1:5672`) — provides the handlers and
exports the runtime port; the handlers are checked against the contract at the
call, not on the first delivery. `runtimeInfo()` reads `{ queues }` back once
consuming.

A worker with several consumers can be several slices instead of one record:
`AmqpHandler(contract, key)({ name: Dep }, arm)` mints a provider for ONE consumer or
rpc, typed by the key alone, and `AmqpHandlers(contract)([...])` composes an
array of them into the same handlers provider `AmqpModule` takes — the array
must cover every key the contract declares, and each piece's own port must
still be discharged (`provides`), since the composed provider's deps are the
pieces' ports, not what they close over. Two slices claiming one key are di's
duplicate-provider defect at build, which is the point: a consumer belongs to
exactly one slice.

## Options

`AmqpModule(name)({...})` takes `amqp()`'s options plus `handlers` and the
module lists (`imports`, `provides`, `exports`, `needs`). The `amqp()`
primitive does not take `handlers` as an option — it **needs** the handlers
provider on its own port, which is how the composition root supplies it:

| Option                   | What it is                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `contract`               | the `amqp-contract` contract; the queues consumed are read off it                                                               |
| `handlers`               | the handlers provider — what `AmqpHandlers(contract)(...)` returns for this contract                                            |
| `url`                    | pins `AMQP_URL` (default `amqp://127.0.0.1:5672`) — a test's container                                                          |
| `connectionOptions`      | `AmqpConnectionOptions`, the library's own connection tuning: heartbeat, reconnect interval, `findServers`, TLS                 |
| `defaultConsumerOptions` | the library's `ConsumerOptions`, applied to every handler: `prefetch` (the throughput knob), `priority`, …                      |
| `connectTimeoutMs`       | pins `AMQP_CONNECT_TIMEOUT_MS` — how long startup waits before an unreachable broker is a `RuntimeStartFailed` (default `5000`) |

The full table — required/optional, defaults, and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/amqp-worker),
which is this list's one detailed home.

## What it decides, and what it does not

`Result` → ack / retry / dead-letter is a **three-way** split and none of it is
this package's: a `RetryableError` / `NonRetryableError` is routed by
`amqp-contract`'s own dispatch against the queue's `retry` config, and a
`Defect` is nacked once, straight to the dead-letter queue, never touching that
budget — which is why the handler above recovers its own defects into a
`RetryableError`. The drain calls `worker.close({ drainTimeoutMs: null })`
raced against the kernel's deadline: the library is told to wait forever, so
there is no second timeout in the process to keep in step. Each delivery is one
unit, `traceId` the publisher's `messageId`. The rest is on the
[documentation site](https://btravstack.github.io/btravstack/reference/amqp-worker).

## License

[MIT](./LICENSE) © Benoit TRAVERS
