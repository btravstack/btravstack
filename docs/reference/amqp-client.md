---
title: AMQP client
description: Bind a typed AMQP publisher to a DI scope without depending on the worker.
---

# `@btravstack/amqp-client`

`amqpClient(port, contract, settingsPort)` returns a resourceful provider of
`TypedAmqpClient<typeof contract>`. Declare `port` in the application; its
service is the typed client for that contract. The settings port supplies
`{ url: string, connectTimeoutMs?: number }`. A missing timeout uses five
seconds. An upstream `ConnectionError` is a modeled startup error.

The provider closes the client when its DI scope closes. A client and an AMQP
worker may use the same broker URL, but the underlying library gives clients
and workers separate connection pools. Publishing a domain event or mapping an
outbox row is the application's decision. See the
[order publisher](/examples/order-amqp-worker) for the working composition.

This package requires `@amqp-contract/client`, `@btravstack/di`,
`@opentelemetry/api`, and `unthrown`. It has no `@btravstack/amqp-worker` peer.
