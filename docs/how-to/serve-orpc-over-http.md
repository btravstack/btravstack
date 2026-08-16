---
title: Serve an oRPC contract over HTTP
description: Implement an oRPC contract as a di-provided router, compose it with HttpModule, and boot it under the kernel with one runMain call.
---

# Serve an oRPC contract over HTTP

> **How-to.** Take a contract, implement it as `Result`-returning procedures,
> and serve it under the kernel's lifecycle with `@btravstack/http`. For the
> package's full surface, see [`@btravstack/http`](/reference/http); for _why_
> the transport maps no `Result` to a status itself, see
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing).

The starter answers HTTP one way: **oRPC, through `@orpc/server/node`'s
`RPCHandler`**, one kernel unit per request, the response flushed before the
unit closes. What you write is the contract, the router and the composition
root. Everything below is lifted from `examples/order-api`.

## Recipe

1. Declare the contract with `@orpc/contract` — inputs, outputs and the
   `.errors({...})` a client may branch on.
2. Implement it with `HttpRouter(contract)(deps, { sync })`: a record
   shaped like the contract, each leaf a `Result`-returning function.
3. Compose with `HttpModule(name)({ router, imports, provides, exports })`.
4. `await runMain(OrderApi)` in `main.ts`.

## Step 1 — the contract

The contract lives in its own package (`order-api-contract`), because a client
needs it and needs none of the server:

```ts
import { oc, type } from "@orpc/contract";

export type OrderView = { readonly id: string; readonly quantity: number };
export type OrderRef = { readonly id: string };

export const orderContract = {
  orders: {
    place: oc
      .input(type<{ readonly id: string; readonly quantity: number }>())
      .output(type<OrderView>())
      .errors({
        INVALID_QUANTITY: { data: type<OrderRef>() },
        CONFLICT: { data: type<OrderRef>() },
      }),
    find: oc
      .input(type<OrderRef>())
      .output(type<OrderView>())
      .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
  },
};
```

## Step 2 — the router, as a provider

`HttpRouter(orderContract)` is di's own `Provider(port)` on the starter's
router port — there is no name to give, a process serves one router — so the
call declares the use cases the procedures call and closes over them. **The `mapErrCases` in each procedure is
the one place a domain error becomes an HTTP answer** — every case named, no
wildcard, so a new domain error is a compile error here:

```ts
import {
  orderContract,
  type OrderView,
} from "@btravstack/example-order-api-contract";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { HttpRouter } from "@btravstack/http";
import { P } from "unthrown";

const view = (order: Order): OrderView => ({
  id: order.id,
  quantity: order.quantity,
});

export const orderRouter = HttpRouter(orderContract)([PlaceOrder, FindOrder], {
  sync: (place, find) => ({
    orders: {
      place: ({ errors }, input) =>
        place
          .execute(input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({
                  message: error.message,
                  data: { id: error.id },
                }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({
                  message: error.message,
                  data: { id: error.id },
                }),
              ),
          ),
      find: ({ errors }, input) =>
        find
          .execute(input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({
                message: error.message,
                data: { id: error.id },
              }),
            ),
          ),
    },
  }),
});
```

Each leaf is the `.result()` handler `@unthrown/orpc` gives an implementer:
`Ok` is the output, a returned `Err` holding an `ORPCError` is typed end to end
(the client sees `code: "CONFLICT"` as a value), and a `Defect` rethrows onto
oRPC's own path, where it collapses to `INTERNAL_SERVER_ERROR`. `implement`,
`os.…`, `.result(...)` and `os.router(...)` are what the call does for you.
oRPC's context stays empty: what a procedure needs, the provider declared.

## Step 3 — the composition root

```ts
import {
  ApplicationModule,
  Logger,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule } from "@btravstack/http";

import { orderRouter } from "./router.js";

export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [ApplicationModule, PersistenceModule],
  exports: [Logger],
});
```

`HttpModule` is `Module(name)({...})` plus `router`: it imports the starter
(`http()`), provides the router and exports `HttpRuntime`, and returns
exactly the module the hand-written form would:

```ts
Module("OrderApi")({
  imports: [ApplicationModule, PersistenceModule, http()],
  provides: [orderRouter],
  exports: [HttpRuntime, Logger],
});
```

Two gates hold at compile time. A root that forgets the starter exports no
runtime port and `start` fails on arity (`NO RUNTIME`). A root that imports
`http()` without providing the router carries an unmet need — the starter's
runtime provider depends on its router port through di — and `start` refuses
the module.

## Step 4 — `main.ts`

```ts
import { runMain } from "@btravstack/core";

import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

await runMain(OrderApi, { unit: RequestModule });
```

That is the whole process. `PORT` (default `3000`), `HOST` (default
`0.0.0.0`) and the kernel's `PROBE_PORT` are read inside the graph from the
`Env` port; a malformed one is a `ConfigInvalid`, reported as `startFailed`
and exit `78`. `RequestModule` is optional — see
[Open a per-request scope](/how-to/open-a-per-request-scope).

## Options

`HttpModule(name)({...})` takes `imports`, `provides`, `exports` and:

| Option     | Default | What it does                                            |
| ---------- | ------- | ------------------------------------------------------- |
| `router`   | —       | the router **provider** `HttpRouter` returned; required |
| `prefix`   | `/rpc`  | where the RPC endpoint is mounted                       |
| `port`     | `PORT`  | pins the port instead of reading the variable           |
| `hostname` | `HOST`  | pins the host instead of reading the variable           |

`http({ prefix?, port?, hostname? })` takes the last three; the router is not
an option but the module's need, provided by the root. Pinning is per field —
`port: 0` still reads `HOST`.

## What the package decides

`Result` → status is **not** in this table: that is the router's `.result()`
triage above. What the package itself answers:

| Request                                     | Answer                                                    | Decided by       |
| ------------------------------------------- | --------------------------------------------------------- | ---------------- |
| a procedure under `prefix`                  | its output, or the `ORPCError` its `Result` was mapped to | oRPC, the router |
| a defect thrown inside a procedure          | oRPC's own `INTERNAL_SERVER_ERROR` collapse               | oRPC             |
| a path under `prefix` naming no procedure   | `404 {"error":"NotFound"}` — oRPC declines it unwritten   | this package     |
| any path outside `prefix`                   | `404 {"error":"NotFound"}` — likewise                     | this package     |
| the listener resolved without writing       | `404 {"error":"NotFound"}`                                | this package     |
| the listener failed before headers were out | `500 {"error":"InternalError"}`                           | this package     |
| a failure with headers already on the wire  | the socket is destroyed — a reset, not a hang             | this package     |

The last three are fallbacks the transport proves against a bare listener; the
two `500` shapes are unreachable over oRPC, which collapses every defect
itself. A `StartOptions.unit` provider that fails to build gets its `500` from
the unit's defect path, before any procedure runs.

## Read the bound port back

`PORT=0` lets the OS pick; the runtime publishes what it got on
`Serving.info`, read through `runtimeInfo()`:

```ts
const app = start(OrderApi, {
  env: { PORT: "0", HOST: "127.0.0.1" },
  signals: false,
  probes: false,
});
const info = (await app.runtimeInfo()).get(); // HttpInfo | undefined
const origin = `http://127.0.0.1:${info?.port}`;
```

`runtimeInfo()` is an `AsyncResult<HttpInfo | undefined, never>` — `undefined`
if the runtime never reached serving.

## Correlate requests

Every request is a unit with a minted `id: randomUUID()`. A non-blank inbound
`x-request-id` header becomes the unit's `traceId`, so a line logged by an
adapter that reads `currentUnit()` joins a trace that started outside the
process; a blank header is ignored rather than winning over the minted id.

## See also

- [`@btravstack/http`](/reference/http) — options, `HttpConfig`, `HttpInfo`, the guarantee.
- [Order API (HTTP)](/examples/order-api) — the example these samples come from, client half included.
- [Open a per-request scope](/how-to/open-a-per-request-scope) — the `RequestModule` in `main.ts`.
- [Configure from the environment](/how-to/configure-from-the-environment) — how `PORT`/`HOST` are bound.
- [Use with oRPC](https://btravstack.github.io/unthrown/how-to/use-with-orpc) — the `@unthrown/orpc` bridge itself.
