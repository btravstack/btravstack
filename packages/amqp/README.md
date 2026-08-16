# @btravstack/amqp

> The AMQP starter for [`@btravstack/core`](../core): an
> [`amqp-contract`](https://github.com/btravstack/amqp-contract) worker under
> the kernel's lifecycle — one unit per delivery, and a drain with exactly one
> deadline, the kernel's own.

📖 **[Documentation](https://btravstack.github.io/start/how-to/consume-amqp-messages)** ·
[Reference](https://btravstack.github.io/start/reference/amqp) ·
[API Reference](https://btravstack.github.io/start/api/amqp/)

```sh
pnpm add @btravstack/amqp @btravstack/core @btravstack/config @btravstack/di unthrown \
  @amqp-contract/worker @opentelemetry/api
```

All six are peer dependencies — install them (`@opentelemetry/api` because
`@amqp-contract/worker` itself peers on it). Node `>=20`. Not yet published:
this repository has not cut a release yet.

## A worked example

```ts
import { AmqpHandlers, AmqpModule } from "@btravstack/amqp";
import { runMain } from "@btravstack/core";
import { ErrAsync, P } from "unthrown";

// The handlers, as a service: one entry per consumer the contract declares,
// built by di from the use cases it lists — no injected context.
const orderHandlers = AmqpHandlers(orderContract)("OrderHandlers")(
  [PlaceOrder],
  {
    sync: (placeOrder) => ({
      placeOrder: (message) =>
        placeOrder
          .execute(message.payload.orderId, message.payload.quantity)
          .map(() => undefined)
          // A modeled domain error is permanent: dead-letter it, no retry.
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("InvalidQuantity"),
              P.tag("DuplicateOrder"),
              (error) => new NonRetryableError(error._tag, error),
            ),
          )
          // Infrastructure failing is not: recover the defect into a retry.
          .recoverDefect((cause) =>
            ErrAsync(new RetryableError("placing the order failed", cause)),
          ),
    }),
  },
);

const Worker = AmqpModule("Worker")({
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
[documentation site](https://btravstack.github.io/start/reference/amqp).

## License

[MIT](./LICENSE) © Benoit TRAVERS
