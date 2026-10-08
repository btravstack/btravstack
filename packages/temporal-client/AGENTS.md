# packages/temporal-client

This package binds the calling half of Temporal to application-declared DI
ports. `temporalConnection(connectionPort, settingsPort)` opens and closes the
native connection. `temporalClient(clientPort, connectionPort, settingsPort)`
constructs `@temporal-contract/client`'s `TypedClient` over that connection.
The two providers keep connection cleanup correct if a later provider fails.
The caller binds its contract through `client.for(contract)`.

The settings port supplies `address` and `namespace`; `TemporalClientUnreachable`
models a failed connection. This package has no worker dependency and owns no
schedule policy. Package tests cover connection cleanup, namespace binding,
and connection error qualification. The worked consumer is
`examples/order-temporal-worker/src/schedules.ts`, exercised by its real
Temporal suite.
