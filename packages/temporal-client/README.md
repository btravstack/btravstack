# `@btravstack/temporal-client`

Bind a native Temporal connection and an `@temporal-contract/client`
`TypedClient` to application DI ports. Add
`temporalConnection(connectionPort, settingsPort)` and
`temporalClient(clientPort, connectionPort, settingsPort)` to the module's
providers. Settings supply `address` and `namespace`. The connection closes
with the module scope; an unreachable service returns the modeled
`TemporalClientUnreachable` error.

Call `client.for(contract)` to obtain the typed workflow and schedule API.
The [schedule deployment](../../examples/order-temporal-worker/src/schedules.ts)
shows the providers in a real module. Workflow arguments and schedule policy
remain in the application.
