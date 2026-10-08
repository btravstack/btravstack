# packages/amqp-client

This package binds `@amqp-contract/client` to an application-declared DI port.
`amqpClient(port, contract, settings)` acquires one typed client when the scope
opens and closes it when the scope ends. It reads `url` and optional
`connectTimeoutMs` from the supplied settings port; the default timeout is
five seconds. The upstream `ConnectionError` stays on the startup error
channel. No application event, outbox mapping, or consumer belongs here.

It has no dependency on `@btravstack/amqp-worker`. A publisher and worker may
share a broker URL while retaining separate connections; the upstream client
and worker use separate pools. The worked consumer is
`examples/order-amqp-worker/src/outbox-publisher.ts`, exercised by its real
RabbitMQ suite.
