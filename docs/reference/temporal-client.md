---
title: Temporal client
description: Bind a typed Temporal client and its connection to DI scopes without depending on the worker.
---

# `@btravstack/temporal-client`

`temporalConnection(connectionPort, settingsPort)` acquires a native Temporal
`Connection` and releases it with the DI scope. Its settings port supplies
`{ address: string, namespace: string }`. A connection failure returns
`TemporalClientUnreachable { address, cause }` on the modeled error channel.

`temporalClient(clientPort, connectionPort, settingsPort)` provides
`@temporal-contract/client`'s `TypedClient` using that connection and
namespace. Bind an application contract with `client.for(contract)`; use
`client.raw` when the native SDK has an operation outside the typed surface.
The [schedule deployment](/examples/order-temporal-worker) is the worked
composition.

`temporalClient(clientPort, connectionPort, settingsPort, dataConverterPort)`
also hands the native client the `DataConverter` that port resolves — the
port the worker's own `dataConverter` option names, so both sides encode and
decode payloads with one codec. See the worker's
[data converter](/reference/temporal-worker#the-data-converter).

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
`@temporalio/common`, `@btravstack/di`, and `unthrown`. It has no worker peer.
