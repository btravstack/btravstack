# packages/amqp-client

This package binds `@amqp-contract/client` to an application-declared DI port.
`amqpClient(port, contract, settings)` acquires one typed client when the scope
opens and closes it when the scope ends. It reads `url` and optional
`connectTimeoutMs` from the supplied settings port; the default timeout is
five seconds. The upstream `ConnectionError` stays on the startup error
channel. No application event, outbox mapping, or consumer belongs here.

`connectTimeoutMs` does not bound `create` against a broker that accepts TCP
and never answers the handshake (btravstack/amqp-contract#796): `close()`
awaits the in-flight connect, which amqplib bounds only with a socket timeout.
The provider sets that timeout to half the connect timeout. amqplib clears it
once the connection opens (`lib/connect.js`, `sock.setTimeout(0)` in the open
callback), so idle connections are unaffected. Half, not equal: measured on
amqplib 2.2.0, an equal timeout loses the race to `waitForConnect`, `close()`
then waits out the 5 s reconnect interval, and the error loses
`connect ETIMEDOUT`. The worker starter shares the rule, in its own copy,
since neither package depends on the other.

The client is given no `logger`, so its `connectFailed` warnings are dropped.
Routing them to `Observers` the way the worker's `brokerLog` does needs a
`@btravstack/core` peer and a no-op observer member, which a bare provider
cannot contribute (issue #747).

It has no dependency on `@btravstack/amqp-worker`. A publisher and worker may
share a broker URL while retaining separate connections; the upstream client
and worker use separate pools. Package tests cover timeout forwarding, cleanup,
and upstream error propagation. The worked consumer is
`examples/order-amqp-worker/src/outbox-publisher.ts`, exercised by its real
RabbitMQ suite.
