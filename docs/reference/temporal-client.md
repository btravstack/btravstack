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

This package requires `@temporal-contract/client`, `@temporalio/client`,
`@temporalio/common`, `@btravstack/di`, and `unthrown`. It has no worker peer.
