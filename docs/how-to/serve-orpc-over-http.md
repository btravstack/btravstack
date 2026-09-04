---
title: Serve an oRPC contract over HTTP
description: Implement an oRPC contract as a di-provided router, compose it with HttpModule, and boot it under the kernel with one runMain call.
---

<!-- doctest: prelude
import { start, Meter, Tracer, Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { HttpRuntime, http } from "@btravstack/http-server";
import { otel } from "@btravstack/observability/otel";
import { api } from "../../auth.js";
import { RequestModule } from "../../request-scope.js";
-->

# Serve an oRPC contract over HTTP

> **How-to.** Take a contract, implement it as `Result`-returning procedures,
> and serve it under the kernel's lifecycle with `@btravstack/http-server`. For the
> package's full surface, see [`@btravstack/http-server`](/reference/http-server); for _why_
> the transport maps no `Result` to a status itself, see
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing).

The starter answers HTTP one way: **oRPC, through `@orpc/server/node`'s
`RPCHandler`**, one kernel unit per request, the response flushed before the
unit closes. What you write is the contract, the router and the composition
root. What follows is a minimal, standalone illustration of that shape — one
contract, one `sync`, no controller layer — sized for a single-slice API. For
an API that has outgrown one `sync`, each slice with its own contract
fragment and controller, see
[Split a router into controllers](/how-to/split-a-router-into-controllers); for
the real two-slice deployment this recipe scales into, see
[Order API (HTTP)](/examples/order-api).

## Recipe

1. Declare the contract with `@orpc/contract` — inputs, outputs and the
   `.errors({...})` a client may branch on, marked
   `authenticated(...requirements)` where a caller must be known.
2. Declare this deployment's security schemes once with
   `defineHttp({ authenticators })`.
3. Implement the contract with `api.OrpcRouter(contract)({ inject: deps, sync })`: a
   record shaped like the contract, each leaf a `Result`-returning function.
4. Compose with
   `HttpModule(name)({ router, imports, provides, exports, needs })`.
5. `await runMain(OrdersApi)` in `main.ts`.

## Step 1 — the contract

The contract lives in its own package, because a client needs it and needs
none of the server:

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderView = z.object({ id: z.uuidv7(), quantity: z.number() });
export type OrderView = z.infer<typeof orderView>;

const orderRef = z.object({ id: z.uuidv7() });
export type OrderRef = z.infer<typeof orderRef>;

// `BAD_REQUEST` names the id **as received**, which is the one value that is
// not a UUIDv7: `orderRef` would reject the only payload it ever carries.
const malformedRef = z.object({ id: z.string() });

export const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(orderView)
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: malformedRef },
      CONFLICT: { data: orderRef },
    }),
  find: oc
    .input(orderRef)
    .output(orderView)
    .errors({ NOT_FOUND: { data: orderRef } }),
});
```

The shapes are **schemas**, and the types are inferred from them rather than
declared beside them: one definition, so what is checked at the boundary and
what the compiler believes cannot drift. oRPC's `type<T>()` would declare the
same types and validate nothing — `{ quantity: "abc" }` would reach `place`
typed `number`.

[`authenticated({ user: [] })`](/reference/contract) marks the whole record
with one OpenAPI security requirement — the `user` scheme, no particular scope
— so every procedure under it needs a caller presenting it, and neither input
names a tenant, because the caller's own identity is what establishes it.
Several requirements are ORed and a procedure may replace the group default
with its own; see
[Protect a procedure](/how-to/protect-a-procedure). Drop the marker and
this is a public API; the rest of the page is unchanged either way, except that
the handlers then have no `context.principal` to read and the router declares
no scheme dependency.

## Step 2 — the router, as a provider

`api.OrpcRouter(ordersContract)` is di's own `Provider(port)` on the starter's
router port — there is no name to give, a process serves one router — so the
call declares the use cases the procedures call and closes over them. **The `mapErrCases` in each procedure is
the one place a domain error becomes an HTTP answer** — every case named, no
wildcard, so a new domain error is a compile error here:

```ts
import { ordersContract, type OrderView } from "./contract.js";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { P } from "unthrown";

import { api } from "./auth.js";

const view = (order: Order): OrderView => ({
  id: order.id,
  quantity: order.quantity,
});

export const ordersRouter = api.OrpcRouter(ordersContract)({
  inject: { place: PlaceOrder, find: FindOrder },
  sync: ({ place, find }) => ({
    place: ({ errors, context }, input) =>
      place
        .execute(context.principal.tenantId, input.id, input.quantity)
        .map(view)
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              errors.INVALID_QUANTITY({
                message: error.message,
                data: { id: error.id },
              }),
            )
            // A malformed id is the caller's mistake, so 400 — not the
            // 409 a duplicate gets.
            .with(P.tag("InvalidOrderId"), (error) =>
              errors.BAD_REQUEST({
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
    find: ({ errors, context }, input) =>
      find
        .execute(context.principal.tenantId, input.id)
        .map(view)
        .mapErrCases((matcher) =>
          matcher.with(P.tag("OrderNotFound"), (error) =>
            errors.NOT_FOUND({
              message: error.message,
              data: { id: error.id },
            }),
          ),
        ),
  }),
});
```

Each leaf is the `.result()` handler `@unthrown/orpc` gives an implementer:
`Ok` is the output, a returned `Err` holding an `ORPCError` is typed end to end
(the client sees `code: "CONFLICT"` as a value), and a `Defect` rethrows onto
oRPC's own path, where it collapses to `INTERNAL_SERVER_ERROR`. `implement`,
`os.…`, `.result(...)` and `os.router(...)` are what the call does for you.
oRPC's context carries **one** thing, and only under a protected procedure: the
`principal` the scheme's authenticator resolved. Everything else a procedure
needs, the provider declared. These two procedures name **one** scheme, so the
principal is that scheme's identity bare; a procedure naming several would get
a discriminated union its handler has to narrow.

`api` is the application's own `auth.ts` binding — the file where
`defineHttp({ authenticators })` states what each scheme resolves to — which
is what gives `context.principal` a readable type here. A marked fragment
reached through anything else types it `never`, so every read is
a compile error: the signal to use the factory, not a fallback. See
[Protect a procedure](/how-to/protect-a-procedure) for that file.

## Step 3 — the composition root

```ts
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";

import { ordersRouter } from "./router.js";

export const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  unit: { anonymous: RequestModule },
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability(),
    otel(),
  ],
  // `RequestModule` reads all three out of the application scope once forked.
  exports: [Logger, Tracer, Meter],
});
```

`HttpModule` is `Module(name)({...})` plus `router`: it imports the starter
(`http()`), provides the router **and the scheme authenticators the router
carries**, and exports
`HttpRuntime`, and returns exactly the module the hand-written form would:

```ts
Module("OrdersApi")({
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability(),
    http(),
  ],
  provides: [ordersRouter, ...ordersRouter.authenticators],
  exports: [HttpRuntime, Logger],
});
```

There is **no authenticator to list**: it rides the router, which is what needs
it, so a scheme cannot be forgotten and cannot be wired to the wrong router.
What the compiler still checks is di's own gate — the router declares one
dependency per scheme its contract names, so a scheme with nobody behind it is
an unmet need `start` refuses, naming the port
(`Type '"HttpAuthenticator:user"' is not assignable to type '"@di/Scope"'`).

[`observability()`](/reference/observability) is the other starter here: it
brings the `Logger` the use cases and the request scope write to, bound from
`LOG_LEVEL`, one JSON object per line on stdout, every line carrying the
trace id of the unit `http()` opened around the request. It is exported
because the per-request `RequestModule` reads it.

Three gates hold at compile time, now that the contract is marked. A root that
forgets the starter exports no runtime port and `start` refuses it against
`"NO RUNTIME — the module exports no port declared over RuntimePort"`. A root
that imports `http()` without providing the router
carries an unmet need — the starter's runtime provider depends on its router
port through di — and `start` refuses the module, naming the port
(`Type 'OrpcRouterPort' is not assignable to type 'Env | Scope'`). And a root serving a **marked**
contract whose `defineHttp` declared no authenticator for one of its schemes
carries that scheme's port as a second unmet
need, refused the same way; drop the marker and that third gate goes with it.

## Step 4 — `main.ts`

```ts
import { runMain } from "@btravstack/core";
import {
  createLogger,
  jsonSink,
  kernelEvents,
} from "@btravstack/observability";

import { OrdersApi } from "./module.js";

await runMain(OrdersApi, {
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

That is the whole process. `PORT` (default `3000`), `HOST` (default
`0.0.0.0`), `LOG_LEVEL` (default `info`) and the kernel's `PROBE_PORT` are
read inside the graph from the
`Env` port; a malformed one is a `ConfigInvalid`, reported as `startFailed`
and exit `78`. Binding `RequestModule` on `unit: { anonymous }` is optional
— see [Open a per-request scope](/how-to/open-a-per-request-scope) — and so
is `onEvent`, which puts the kernel's own lifecycle events in the application's
stream rather than the default JSON on stderr; see
[Log and correlate](/how-to/log-and-correlate).

## Options

`HttpModule(name)({...})` takes `imports`, `provides`, `exports`, `needs` and:

| Option     | Default | What it does                                                |
| ---------- | ------- | ----------------------------------------------------------- |
| `router`   | —       | the router **provider** `api.OrpcRouter` returned; required |
| `prefix`   | `/rpc`  | where the RPC endpoint is mounted                           |
| `port`     | `PORT`  | pins the port instead of reading the variable               |
| `hostname` | `HOST`  | pins the host instead of reading the variable               |

There is no `authenticator` option: the scheme authenticators ride the router
and the sugar puts them in `provides` itself.

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
itself. A bound `unit.anonymous` provider that fails to build gets its `500`
from the unit's defect path, before any procedure runs.

## Read the bound port back

`PORT=0` lets the OS pick; the runtime publishes what it got on
`Serving.info`, read through `runtimeInfo()`:

```ts
const app = start(OrdersApi, {
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
`observability()`'s logger reads that record per call, so every line written
under the request already carries it — see
[Log and correlate](/how-to/log-and-correlate).

## See also

- [`@btravstack/http-server`](/reference/http-server) — options, `HttpConfig`, `HttpInfo`, the guarantee.
- [Protect a procedure](/how-to/protect-a-procedure) — the marker, `auth.ts`
  and the authenticators this page uses, in full, plus scopes and the 401/403
  split.
- [Order API (HTTP)](/examples/order-api) — the real deployment this recipe
  scales into, two slices composed through controllers, client half included.
- [Open a per-request scope](/how-to/open-a-per-request-scope) — binding `RequestModule` on `HttpModule`'s own `unit` option.
- [Configure from the environment](/how-to/configure-from-the-environment) — how `PORT`/`HOST` are bound.
- [Use with oRPC](https://btravstack.github.io/unthrown/how-to/use-with-orpc) — the `@unthrown/orpc` bridge itself.
