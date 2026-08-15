# @btravstack/http

**The HTTP starter for [`@btravstack/core`](https://github.com/btravstack/start):
oRPC on Hono, one unit per request, and a drain that actually stops
accepting.**

Routing is oRPC's; the fetch idiom is Hono's. What is genuinely hard is the
lifecycle underneath them — flushing the response inside the unit the kernel is
tracking, and a drain that stops accepting rather than merely saying it does.
This package owns exactly that, plus the one decision a starter is for: how an
application's router becomes an HTTP surface. There is **one** way, and it is
enforced rather than offered among alternatives.

## Install

```sh
pnpm add @btravstack/http @btravstack/core @btravstack/config @btravstack/di unthrown hono @hono/node-server @orpc/server
```

All of those are peer dependencies — install every one, so the application
holds a single copy of each. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A worked example

The application provides its **router as a provider** — one that declares the
use cases its procedures call, so the router is built by di like everything
else and oRPC's own context stays empty — and `HttpModule(name)({...})` is a
`Module(name)({...})` that also knows about it: everything a di module takes,
plus `router`, and nothing else to know. Under the hood it imports the starter
(`http({ router })` — the runtime on `HttpRuntime`, `HttpConfig` bound from
`PORT` and `HOST`, the router mounted on Hono under `/rpc`), provides the
router and exports `HttpRuntime`, and hands back exactly the module
`Module(...)` would have declared: syntax over the same primitives.

```ts
import { runMain } from "@btravstack/core";
import { HttpModule, HttpRouter } from "@btravstack/http";
import { P } from "unthrown";

const orderRouter = HttpRouter(orderContract)("OrderRouter")(
  [PlaceOrder, FindOrder],
  {
    sync: (place, find) => ({
      orders: {
        place: ({ errors }, input) =>
          place
            .execute(input.id, input.quantity)
            .map(view)
            .mapErrCases((m) =>
              m.with(P.tag("DuplicateOrder"), (e) =>
                errors.CONFLICT({ data: { id: e.id } }),
              ),
            ),
        find: ({ errors }, input) =>
          find.execute(input.id).map(view).mapErrCases(/* … */),
      },
    }),
  },
);

const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [Application, Persistence],
});

await runMain(OrderApi);
```

`HttpRouter(orderContract)("OrderRouter")` is **contract-first**: the
implementation is a record shaped like the contract whose leaves are plain
`Result`-returning functions — `(helpers, input) => AsyncResult<Output,
ORPCError>`, the `.result()` handler `@unthrown/orpc` gives an implementer —
typed by the contract at the call: a typo'd key, a missing procedure, a wrong
output are compile errors there. `implement(contract)`, `os.…`, `.result(...)`
and `os.router(...)` are what the call does for you. Its first two calls mint
the router's port and its last is di's `Provider(port)(deps, { sync })`, so the
provider it returns carries the port typed: `orderRouter.port`. No class line,
no `implement`, no builder. `http({ router: orderRouter.port })` — the starter
module itself, taking the port class — stays exported for a composition root
written by hand (`Module("OrderApi")({ imports: [Application, Persistence,
http({ router: orderRouter.port })], provides: [orderRouter], exports:
[HttpRuntime] })` is what `HttpModule` produces).

That is a whole `main.ts`: `PORT` (default `3000`), `HOST` (default
`0.0.0.0`) and the kernel's `PROBE_PORT` are read inside the graph, from the
`Env` port the kernel provides — nothing is passed in — and a malformed one is
a `ConfigInvalid` the kernel reports as a `startFailed` event and exit `78`. A
test boots the same `OrderApi` with `start(OrderApi, { env: { PORT: "0",
HOST: "127.0.0.1" } })` and reads the bound port back from
`app.runtimeInfo()`.

Two compile-time gates guard the composition. `start` finds the runtime by the
`HttpRuntime` port the composition root exports; a module that exports none
fails on arity at the call. And `http({ router })`'s runtime provider depends
on the router port through di, so a composition that imports the starter
without providing its router carries an unmet need and `start` refuses the
module — di's gate, not the kernel's. Neither can be forgotten at runtime.

`router` is constrained at the call: a port whose service is not an oRPC
router that `RPCHandler` can serve with no initial context fails to typecheck
there, not at the first request. This starter has no context to hand a
procedure — what a procedure needs, the router's provider declares.

## The guarantee

Every request produces exactly one completed response, and its unit stays
open until that response is on the wire.

A unit closes the instant its work resolves, and an idle registry is the
kernel's permission to call `Serving.stop()`. A runtime that resolves the unit
and only then writes to the client is racing `stop()` tearing the transport
down — with a small body the write usually wins, with a large one it does not
(measured with an 8 MB body: `UND_ERR_SOCKET: other side closed`). This
package makes that race impossible rather than merely documenting it: the
unit's lifetime **is** the response's, so there is no seam between "the
handler is done" and "the bytes are out" for a write to land in.

The guarantee has one edge: it covers a response the package itself finishes.
Once headers are on the wire, there is no status left to set, and finishing
the response belongs to whoever started it; the package will not double-write
over it.

## What it decides

| Request                                     | Answer                                                                | Decided by       |
| ------------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| a procedure under `prefix`                  | the procedure's output, or the `ORPCError` its `Result` was mapped to | oRPC, the router |
| a defect thrown inside a procedure          | oRPC's own `INTERNAL_SERVER_ERROR` collapse                           | oRPC             |
| a path under `prefix` naming no procedure   | falls through to Hono — its `404`                                     | Hono             |
| any path outside `prefix`                   | Hono's `404`                                                          | Hono             |
| the listener resolved without writing       | `404 {"error":"NotFound"}`                                            | this package     |
| the listener failed before headers were out | `500 {"error":"InternalError"}`                                       | this package     |
| a failure with headers already on the wire  | the socket is destroyed — a reset the client sees, not a hang         | this package     |

The last three are the package's own fallbacks and, over the oRPC surface it
ships, unreachable in practice: Hono answers every path and oRPC collapses
every defect. They exist because the transport is proven on its own, against a
bare listener, and a listener that declines or fails must still produce
exactly one response. "Failed" there covers a rejected promise, a
**synchronous** throw before anything awaitable was returned, and a
`StartOptions.unit` provider that failed to build — the last two never reach
the listener's promise, so the `500` is written from the unit's defect path
instead.

`Result` → HTTP status is **not** in that table, deliberately. It is the
router's `.result()` triage — `@unthrown/orpc`'s builder extension, where the
`mapErrCases` names every domain error and turns it into a typed `ORPCError`
at the one place that has to decide what a client sees. A `Defect` is never
named there: it was never modelled, so collapsing it to a 500 is the correct
treatment, and oRPC does it.

## Options

`HttpModule(name)({...})` takes everything `Module(name)({...})` takes —
`imports`, `provides`, `exports` — plus:

| Option     | Required |                                                                                                                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `router`   | yes      | the application's router **provider** — over a port whose service is a context-free oRPC router; the sugar provides it and the runtime provider depends on it through di |
| `prefix`   | no       | where the RPC endpoint is mounted; default `/rpc`                                                                                                                        |
| `port`     | no       | pins the port instead of reading `PORT`                                                                                                                                  |
| `hostname` | no       | pins the host instead of reading `HOST`                                                                                                                                  |

`http({ router, prefix?, port?, hostname? })` takes the same four, with
`router` the port **class** — it is what the sugar imports.

## Configuration

What the socket is bound with is `HttpConfig`, `{ port, hostname }` — a port
`http()` provides from the environment and anything else in the graph may
read. `port` and `hostname` **pin** a field instead of reading it — explicit
beats environment beats default, **per field**, so `http({ router, port: 0 })`
still reads `HOST`. Pin both and the module reads nothing: no `Env` need, no
`ConfigInvalid`, which is what its overloads say.

| Variable | Default   |                                                                                                                               |
| -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PORT`   | `3000`    | `0` lets the OS pick — read the real one back from `RunningApp.runtimeInfo()`                                                 |
| `HOST`   | `0.0.0.0` | the deployment target is a pod, not a laptop; it also means the server is reachable beyond loopback — set `127.0.0.1` locally |

An unset variable takes the default; a set-but-empty one is an error, and so is
`PORT=abc` or `PORT=70000` — `Config.port` from `@btravstack/config` decides
what a port is, once, and `PORT=0` is legal.

## What it does not do

- **Any other router or handler.** oRPC on Hono is the one way HTTP is
  answered here — oRPC shares this stack's convictions (a contract, typed
  errors, `Result` at the boundary), so it is enforced, not offered among
  alternatives. There is no `handler` option and no listener port to provide
  yourself; the former `@btravstack/orpc` was folded into this package for
  exactly that reason.
- **Middleware.** oRPC's own, in the router's procedures; the package mounts
  the router and puts nothing in front of it.
- **`Result` → HTTP status.** The router's `.result()` triage owns it, at the
  one place that has to decide what a client sees; shipping a mapping in the
  transport is how a lifecycle package turns into a framework.
- **HTTPS.** `node:http` only; terminate TLS at the ingress or load balancer
  in front of the pod, which is where it already terminates for most
  deployments.
- **HTTP/2.** Same `node:http`-only boundary.

## Writing a runtime

`@btravstack/core` states two obligations a runtime owes that the kernel
cannot check for you (see its README's own _Writing a runtime_ section). This
package exists to discharge both on the caller's behalf, so an application
built on it gets them for free rather than having to get them right by hand:

- **Flush the response inside the unit.** The unit's work does not settle
  until the response's `'close'` event fires, so there is no way to write
  late — the failure mode the kernel can only document, this package makes
  structurally unreachable. (A response already closed by the time the work
  runs — a client that hung up during a slow `StartOptions.unit` build —
  settles at once rather than waiting for a `'close'` that has fired.)
- **`UnitMeta.id` unique per unit.** The package mints `id: randomUUID()` for
  every request itself; a caller never gets the chance to pass a route
  template and silently collapse every request onto one trace id. An inbound
  non-blank `x-request-id` becomes `traceId` — the correlation id an outside
  caller supplies — and a blank one is ignored rather than winning over the
  minted id.

One more thing the package does on the caller's behalf: `@hono/node-server`'s
`getRequestListener` runs with `overrideGlobalObjects: false`. Its default
swaps `globalThis.Request`/`Response` for Hono's own on the first request
served — a process-wide side effect no composition root should get by
surprise.

## License

[MIT](./LICENSE) © Benoit TRAVERS
