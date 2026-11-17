# `@btravstack/amqp-client`

> The **calling half** of AMQP for [`@btravstack/core`](../core): a
> contract-typed `TypedAmqpClient` bound to a port the application names,
> opened as the DI scope opens and closed as it ends — with no worker peer.

📖 **[Reference](https://btravstack.github.io/btravstack/reference/amqp-client)** ·
[API Reference](https://btravstack.github.io/btravstack/api/amqp-client/)

```sh
pnpm add @btravstack/amqp-client @btravstack/core @btravstack/config \
  @btravstack/di @amqp-contract/client @opentelemetry/api unthrown
```

Every dependency is a peer. Node `>=22.22`.

## A worked example

<!-- doctest: prelude
import { Module, Port } from "@btravstack/di";
import type { AnyAmqpContract } from "@btravstack/amqp-client";
declare const ordersContract: AnyAmqpContract;
-->

Name the port, then import the module beside the application:

```ts
import type { TypedAmqpClient } from "@amqp-contract/client";
import { amqpClient } from "@btravstack/amqp-client";

class OrdersPublisher extends Port("ReadmeOrdersPublisher")<
  TypedAmqpClient<typeof ordersContract>
> {}

export const Publishing = Module("Publishing")({
  imports: [amqpClient(OrdersPublisher, ordersContract)],
  exports: [OrdersPublisher],
});
```

The module reads `AMQP_URL` and `AMQP_CONNECT_TIMEOUT_MS`, the worker
starter's own variables, and fails start-up with a `ConfigInvalid` naming a bad
one. A broker that does not answer within the connect timeout, AMQP handshake
included, is the upstream `ConnectionError` on the startup channel. It
contributes an `amqp-client:<port id>` health check that fails while the client
is not connected, and reports the library's warnings and errors to `Observers`.
Naming the port is what lets one process hold a client per contract.

The [order publisher](../../examples/order-amqp-worker/src/outbox-publisher.ts)
is a complete example. Its `OutboxPublisher` maps committed rows to the
application's event envelope; that mapping stays in the application.

## Options

| Option                    | Where                                     | What it is                                                  |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `AMQP_URL`                | environment, pinned by `url`              | the broker (default `amqp://127.0.0.1:5672`)                |
| `AMQP_CONNECT_TIMEOUT_MS` | environment, pinned by `connectTimeoutMs` | how long start-up waits for the connection (default `5000`) |

The full table lives on the
[reference page](https://btravstack.github.io/btravstack/reference/amqp-client).
