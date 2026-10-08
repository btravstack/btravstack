# `@btravstack/amqp-client`

Bind a contract-specific `TypedAmqpClient` to a DI port. Define the client
port in the application and pass it, the contract, and a settings port to
`amqpClient(port, contract, settings)`. Settings provide `url` and optionally
`connectTimeoutMs` (default 5 seconds). The provider acquires the client at
scope opening, returns the upstream `ConnectionError` on failure, and closes
the client when the scope ends.

The [order publisher](../../examples/order-amqp-worker/src/outbox-publisher.ts)
is a complete example. Its `OutboxPublisher` maps committed rows to the
application's event envelope; that mapping stays in the application.
