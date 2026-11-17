# `@btravstack/temporal-client`

A module providing an `@temporal-contract/client` `TypedClient` on a DI port
the application declares, over a native Temporal connection opened and closed
with the module scope. Import `temporalClient(port)` where the client is used;
the application names the port, so a process can hold several clients.

<!-- doctest: isolate
import { Port } from "@btravstack/di";
import type { TypedClient } from "@temporal-contract/client";
-->

```ts
import { Module } from "@btravstack/di";
import { temporalClient } from "@btravstack/temporal-client";

class OrdersClient extends Port("OrdersClient")<TypedClient> {}

export const Scheduling = Module("Scheduling")({
  imports: [temporalClient(OrdersClient)],
  exports: [OrdersClient],
});
```

It reads `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`) and `TEMPORAL_NAMESPACE`
(default `default`) from the environment, each pinned by the `address` and
`namespace` options, and the connection's security from Temporal's own
variables (`TEMPORAL_TLS`, `TEMPORAL_TLS_SERVER_CA_CERT_PATH`,
`TEMPORAL_TLS_SERVER_NAME`, `TEMPORAL_TLS_CLIENT_CERT_PATH`,
`TEMPORAL_TLS_CLIENT_KEY_PATH`, `TEMPORAL_API_KEY`, `TEMPORAL_API_KEY_PATH`) —
the worker starter's variables and defaults. Mounted files are read again
every `TEMPORAL_CREDENTIALS_RELOAD_MS`, so a renewed certificate or key is
used without a restart; a reading that fails is reported to `Observers`.
Atomic projected Secret generations are read coherently, with bounded retry
when their targets change; stable missing and empty files remain reported
together. A value or combination it cannot connect with is a `ConfigInvalid`;
an unreachable service is the modeled `TemporalClientUnreachable`. See the
[reference](https://btravstack.github.io/btravstack/reference/temporal-client#securing-the-connection).

The module contributes a `temporal-client:<port id>` health check, which asks
the service's gRPC health endpoint over the current connection.

Pass `dataConverter: converterPort` to encode payloads with the
`DataConverter` that port resolves — the same port the worker's
`dataConverter` option names.

Call `client.for(contract)` to obtain the typed workflow and schedule API.
The [schedule deployment](../../examples/order-temporal-worker/src/schedules.ts)
shows the module in a real graph. Workflow arguments and schedule policy
remain in the application.

`client.for(contract)` also runs a contract's activity with no workflow around
it (Temporal Server 1.32 or later):

<!-- doctest: skip — fragment: `client` and `pdfContract` are the application's -->

```ts
const result = await client.for(pdfContract).executeActivity("renderInvoice", {
  activityId: `invoice-${invoiceId}`,
  args: { invoiceId },
});
```

`startActivity` returns a handle at once and `getActivityHandle` reattaches to
one.

An application can supply renewable bearer credentials through an `apiKey`
option naming a port implementing `TemporalApiKeySource.read()`. The source owns token acquisition,
caching and expiry; the starter polls it with the credentials reload interval.
A source requires TLS and excludes inline/file API keys and mTLS. See the
[reference](https://btravstack.github.io/btravstack/reference/temporal-client#renewable-bearer-credentials)
for composition and fail-closed behavior.
