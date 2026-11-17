---
"@btravstack/temporal-client": minor
---

**Breaking:** `temporalConnection(connectionPort, settingsPort, { apiKey? })`
and `temporalClient(clientPort, connectionPort, settingsPort, dataConverter?)`
are replaced by one call, `temporalClient(clientPort, options?)`, which returns
a `Module` that peers on `@btravstack/core`. The connection is now the
module's own; the settings port, `TemporalClientSettings`, `temporalSecurity`
and `TemporalConnectionSecurity` are gone from the surface. The module reads
`TEMPORAL_ADDRESS` (default `127.0.0.1:7233`), `TEMPORAL_NAMESPACE` (default
`default`) and the connection-security variables, the worker starter's,
pinning the first two by the `address` and `namespace` options. Its error
channel is `ConfigInvalid | TemporalClientUnreachable`, with
`TemporalApiKeyUnavailable` when `apiKey` is given. It contributes a
`temporal-client:<port id>` health check that asks the service's gRPC health
endpoint, and reports a credential file it cannot re-read to `Observers`.

Migration: install `@btravstack/core`, drop the connection and settings ports,
and move the call from `provides` to `imports`; the converter and the API key
source become options.

```ts
// Before
Module("Scheduling")({
  provides: [
    temporalSettings,
    temporalConnection(OrdersConnection, TemporalSettings, { apiKey: OrdersApiKey }),
    temporalClient(OrdersClient, OrdersConnection, TemporalSettings, OrdersConverter),
  ],
});

// After
Module("Scheduling")({
  imports: [temporalClient(OrdersClient, { apiKey: OrdersApiKey, dataConverter: OrdersConverter })],
});
```

A settings port that did not read those variables becomes options:
`temporalClient(OrdersClient, { address, namespace })`. Code that needed the
raw connection reads `client.raw.connection`.
