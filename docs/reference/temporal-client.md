---
title: Temporal client
description: Bind a typed Temporal client and its connection to DI scopes without depending on the worker.
---

# `@btravstack/temporal-client`

`temporalClient(port, options?)` is a module providing
`@temporal-contract/client`'s `TypedClient` on the port the application
declares, over a native Temporal `Connection` opened with the DI scope and
closed with it. The application names the port, so a process can hold several
clients. Bind a contract with `client.for(contract)`; use `client.raw` when the
native SDK has an operation outside the typed surface. The
[schedule deployment](/examples/order-temporal-worker) is the worked
composition.

```ts
import { temporalClient } from "@btravstack/temporal-client";
import { Module, Port } from "@btravstack/di";
import type { TypedClient } from "@temporal-contract/client";

class OrdersClient extends Port("OrdersClient")<TypedClient> {}

export const Scheduling = Module("Scheduling")({
  imports: [temporalClient(OrdersClient)],
  exports: [OrdersClient],
});
```

The module provides the client port and a `HealthChecks` member, and exports
both. Its error channel is `ConfigInvalid | TemporalClientUnreachable`, with
`TemporalApiKeyUnavailable` added when `apiKey` is given. A connection failure
is `TemporalClientUnreachable { address, cause }`.

## Configuration

The variables and defaults are the
[worker's](/reference/temporal-worker#temporalconfig-and-the-environment), read
by this module from `Env`:

| Variable                         | Default          | Pinned by   |
| -------------------------------- | ---------------- | ----------- |
| `TEMPORAL_ADDRESS`               | `127.0.0.1:7233` | `address`   |
| `TEMPORAL_NAMESPACE`             | `default`        | `namespace` |
| `TEMPORAL_TLS`, `TEMPORAL_TLS_*` | unset            | —           |
| `TEMPORAL_API_KEY`               | unset            | —           |
| `TEMPORAL_API_KEY_PATH`          | unset            | —           |
| `TEMPORAL_CREDENTIALS_RELOAD_MS` | `60000`          | —           |

A pinned field reads nothing from the environment, and the module's type says
so: its needs name exactly the variables it may read. A value it cannot parse
is a `ConfigInvalid` against the client's port, before any connection.

| Option          | What it is                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`       | Pins `TEMPORAL_ADDRESS`                                                                                                                                                             |
| `namespace`     | Pins `TEMPORAL_NAMESPACE`                                                                                                                                                           |
| `dataConverter` | An application port for the `DataConverter` the client encodes payloads with — the [worker's](/reference/temporal-worker#the-data-converter) own option names the same port. A need |
| `apiKey`        | An application port implementing `TemporalApiKeySource` (below). A need, and `TemporalApiKeyUnavailable` joins the errors                                                           |

## Health

The module contributes `temporal-client:<port id>` to `HealthChecks`. It asks
the service's gRPC health endpoint for the workflow service, as Temporal's Go
SDK `CheckHealth` does, through the provided connection, so after a rotation it
asks the current one. It fails with `HealthCheckFailed` when the service
answers anything but `SERVING`, does not answer, or the connection is closed.
It does not gate `/readyz`.

## Securing the connection

The variables, the refusals and the rotation are those of the
[worker](/reference/temporal-worker#securing-the-connection), with two
differences:

- A refused combination or unreadable file is a `ConfigInvalid` against the
  client's port, on the module's error channel beside
  `TemporalClientUnreachable`.
- A changed certificate, key or CA opens a new `Connection` and the client
  moves its calls to it: the connection is a facade over the current one, so a
  `Client` built on it keeps working. The grpc-js `Connection` cannot change
  its TLS in place; the replaced connection is closed once its started calls
  finish. A changed API key alone is set with `setApiKey`. A `withDeadline`,
  `withAbortSignal`, `withMetadata` or `withApiKey` scope belongs to the
  connection it was opened on: a call made inside one after a rotation goes out
  without it. Keep such scopes short, or around a single call.

A file that cannot be read again is reported to `Observers` as
`temporal-client` / `reload` with an error outcome, and retried on the next
tick.

## Renewable bearer credentials

Compose an application port implementing `TemporalApiKeySource` through
`temporalClient(port, { apiKey: credentialsPort })`. Both the source type and
`TemporalApiKeyUnavailable` are exported from this package's root. Its
`read(): AsyncResult<string, TemporalApiKeyUnavailable>` obtains the current
credential; the application owns acquisition, expiry and any cache. This works
with an OAuth token source without making Temporal depend on OAuth.

A source turns TLS on when unset. Explicit TLS off, an inline/file API key, or
mTLS alongside it is a `ConfigInvalid` before any source read. The server CA
and server name settings remain available. An unavailable or blank initial
credential prevents startup with `TemporalApiKeyUnavailable`; its diagnostic
contains no credential value.

The starter reads the source again every `TEMPORAL_CREDENTIALS_RELOAD_MS`
(default `60000`). Choose an interval shorter than the source's early-refresh
margin so a valid replacement is installed before expiry. The starter keeps no
token-expiry cache. A changed credential is installed with `setApiKey` on the
current connection.

If a subsequent read or apply fails, the client closes its current connection.
Calls fail until a successful source read opens a fresh connection, including
when the same credential returns. It never falls back to the previous key.
Closing the DI scope stops polling and waits for a read already in flight.

## Standalone activities

`client.for(contract)` also runs a contract's global activity with no workflow
around it, on `@temporal-contract/client` 8.0.0-beta.15: `startActivity(name,
options)`, `executeActivity(name, options)` (start, then the result) and
`getActivityHandle(name, activityId)`. They need **Temporal Server 1.32 or
later**; the activity's worker is an
[activity-only worker](/reference/temporal-worker#an-activity-only-worker).

<!-- doctest: skip — fragment: `client` and `pdfContract` are the application's -->

```ts
const result = await client.for(pdfContract).executeActivity("renderInvoice", {
  activityId: `invoice-${invoiceId}`,
  args: { invoiceId },
});
```

This package requires `@temporal-contract/client`, `@temporal-contract/contract`, `@temporalio/client`,
`@temporalio/common`, `@btravstack/config`, `@btravstack/core`, `@btravstack/di`, and `unthrown`. It has no worker peer.
