---
title: AMQP client
description: Bind a typed AMQP publisher to a DI scope without depending on the worker — amqpClient, AMQP_URL and AMQP_CONNECT_TIMEOUT_MS, its health check and its observations.
---

<!-- doctest: prelude
import type { TypedAmqpClient } from "@amqp-contract/client";
import { Module, Port } from "@btravstack/di";
import type { AnyAmqpContract } from "@btravstack/amqp-client";
declare const ordersContract: AnyAmqpContract;
-->

# `@btravstack/amqp-client`

```sh
pnpm add @btravstack/amqp-client @btravstack/core @btravstack/config \
  @btravstack/di @amqp-contract/client @opentelemetry/api unthrown
```

Every dependency is a peer. It has no `@btravstack/amqp-worker` peer.

## `amqpClient(port, contract, options?)`

Returns a `Module` that provides and exports `port` and `HealthChecks`.
Declare `port` in the application; its service is the typed client for
`contract`. Naming the port is what lets one process hold a client per
contract.

```ts
import { amqpClient } from "@btravstack/amqp-client";

class OrdersPublisher extends Port("OrdersPublisher")<
  TypedAmqpClient<typeof ordersContract>
> {}

export const Publishing = Module("Publishing")({
  imports: [amqpClient(OrdersPublisher, ordersContract, { connectTimeoutMs: 10_000 })],
  exports: [OrdersPublisher],
});
```

The module's type is
`Module<PortInstance<Id, TypedAmqpClient<C>> | HealthChecks, ConfigInvalid | ConnectionError, EnvReading<never, …>>`:
both variables are optional at the boot site, since each has a default, and a
pinned one is not read at all.

| Variable                  | Option             | Default                 | What it is                                                    |
| ------------------------- | ------------------ | ----------------------- | ------------------------------------------------------------- |
| `AMQP_URL`                | `url`              | `amqp://127.0.0.1:5672` | the broker                                                    |
| `AMQP_CONNECT_TIMEOUT_MS` | `connectTimeoutMs` | `5000`                  | how long `create` waits for the connection and topology setup |

They are the worker starter's own variables and defaults, so a deployment that
publishes and consumes sets one broker. A bad value is a `ConfigInvalid` naming
the variable, and `startFailed` with exit `78` under `runMain`.

## Start-up and teardown

The client is acquired as the scope opens and closed as it ends. An upstream
`ConnectionError` is a modeled startup error; its `_tag`,
`@amqp-contract/ConnectionError`, is the code a production
`diagnosticPolicy({ codes })` lists to keep it named.

The timeout also bounds a broker that accepts TCP but never answers the AMQP
handshake: `@amqp-contract/client` 3.0.1 sets amqplib's socket timeout to half of it, so the
error arrives within the timeout and reads `connect ETIMEDOUT`. amqplib clears
that socket timeout once the connection opens.

A client and an AMQP worker may use the same broker URL, but the underlying
library gives clients and workers separate connection pools. Publishing a
domain event or mapping an outbox row is the application's decision. See the
[order publisher](/examples/order-amqp-worker) for the working composition.

## Health and observations

The module contributes the `amqp-client:<port id>` health check to `/healthz`.
It fails with `HealthCheckFailed` while the client is not connected — while
the library reconnects, publishes are buffered up to its publish timeout.

The library's `warn` and `error` lines — a failed connection attempt, a
channel error, a dropped RPC reply — are reported to `Observers` as
`component: "amqp-client"`, `name: "broker"` operations with an `error`
outcome, the level as an attribute and the message as a detail. `debug` and
`info` lines are dropped. A root that composes
[`observability()`](/reference/observability) gets them as log lines; one that
does not pays nothing.
