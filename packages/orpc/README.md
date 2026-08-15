# @btravstack/orpc

**The oRPC starter for [`@btravstack/http`](../http): a router port in, the
`HttpHandler` provider out.**

An application provides its oRPC router as a service — a provider that declares
the use cases its procedures call — and `orpc(RouterPort)` turns that into the
HTTP surface `@btravstack/http` needs. Hono owns routing and the fetch idiom;
oRPC's fetch adapter is mounted under a prefix; nothing here maps a `Result` to
a status.

## Install

```sh
pnpm add @btravstack/orpc @btravstack/http @btravstack/core @btravstack/di unthrown hono @hono/node-server @orpc/server
```

Everything but the package itself is a peer dependency. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## The whole HTTP surface

```ts
import { orpc } from "@btravstack/orpc";
import { http, HttpHandler, HttpRuntime } from "@btravstack/http";

class OrderRouter extends Port("OrderRouter")<ReturnType<typeof routerOf>> {}

const Api = Module("Api")({
  provides: [
    Provider(OrderRouter)([PlaceOrder, FindOrder], { sync: routerOf }),
    orpc(OrderRouter, { prefix: "/rpc" }),
  ],
  exports: [HttpHandler],
});

const OrderApi = Module("OrderApi")({
  imports: [ApplicationModule, PersistenceModule, Api, http()],
  exports: [HttpRuntime, HttpHandler],
});

await runMain(OrderApi);
```

`routerOf(place, find)` is `implement(contract).router({...})` — the router is a
pure function of the contract and the services it is handed, and oRPC's own
context stays empty: one container, not two. A port whose service is not a
router `RPCHandler` can serve with no initial context does not typecheck at the
`orpc(...)` call.

## What it decides

| Request                           | Answer                                               |
| --------------------------------- | ---------------------------------------------------- |
| a procedure under `prefix`        | oRPC's response                                      |
| under `prefix`, no such procedure | Hono's `404` — the adapter declines and Hono answers |
| anywhere else                     | Hono's `404`                                         |
| a defect inside a procedure       | oRPC's own `INTERNAL_SERVER_ERROR` collapse          |

`getRequestListener` runs with `overrideGlobalObjects: false`: its default swaps
`globalThis.Request`/`Response` for Hono's own on the first request served, a
process-wide side effect no composition root should get by surprise.

## Options

| Option   | Default |                                   |
| -------- | ------- | --------------------------------- |
| `prefix` | `/rpc`  | where the RPC endpoint is mounted |

## License

[MIT](./LICENSE) © Benoit TRAVERS
