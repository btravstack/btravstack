# @btravstack/http

**The HTTP runtime for [`@btravstack/core`](https://github.com/btravstack/start):
one unit per request, and a drain that actually stops accepting.**

Routing and middleware are solved by oRPC, Hono, Express and half a dozen
others. What is genuinely hard is the lifecycle underneath them — flushing the
response inside the unit the kernel is tracking, and a drain that stops
accepting rather than merely saying it does. This package owns exactly that,
and nothing a router already does better.

## Install

```sh
pnpm add @btravstack/http @btravstack/core @btravstack/di unthrown
```

`@btravstack/core`, `@btravstack/di` and `unthrown` are peer dependencies —
install all three. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A worked example

The HTTP surface is a service your module provides — the package's own
`HttpHandler` port — and the runtime needs exactly that:

```ts
import { HttpHandler, httpRuntime } from "@btravstack/http";

const ApiModule = Module("Api")({
  provides: [
    Provider(HttpHandler)([PlaceOrder, FindOrder], {
      sync: (place, find) => (req, res) =>
        rpc.handle(req, res, { context: { place, find } }),
    }),
  ],
  exports: [HttpHandler],
});

start(OrderApiModule, { runtime: httpRuntime({ port: env.PORT }) });
```

Or with [Hono](https://hono.dev), via `@hono/node-server`'s
`getRequestListener` — **not** its `serve()`, which creates and owns its own
`node:http` server; standing one up is the job this package takes over:

```ts
import { getRequestListener } from "@hono/node-server";

Provider(HttpHandler)({
  value: getRequestListener(app.fetch, { overrideGlobalObjects: false }),
});
```

A module that does not export `HttpHandler` fails to compile at the `start`
call — that is `start`'s own needs gate, and `HttpHandler` is the one need
this runtime declares. What the handler itself needs is its provider's
business, so it is injected by di like anything else; and because the runtime
resolves the port out of **each request's** context, the provider may live in
the `StartOptions.unit` module instead, where it is built once per request
with per-request dependencies (a transaction) injected the same way.

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

The guarantee has one edge: it covers a response the package itself finishes —
a handler that declines (resolves without writing) or fails before sending
headers gets a `404` or `500` from the package. Once headers are on the wire,
there is no status left to set, and finishing the response is the handler's
own job from that point on; the package will not double-write over it.

## What it does not do

- **Routing.** oRPC, Hono and Express already do this well; the package takes
  a node request and response, not a route table.
- **Middleware.** Same reason — compose your own chain in front of the
  `handler` you pass in.
- **`Result` → HTTP status.** This differs per API style (oRPC's typed errors,
  a plain REST 400), and shipping a mapping nobody asked for is how a
  lifecycle package turns into a framework. Fold it in your own handler.
- **HTTPS.** `node:http` only; terminate TLS at the ingress or load balancer
  in front of the pod, which is where it already terminates for most
  deployments.
- **HTTP/2.** Same `node:http`-only boundary — framing belongs to a routing
  library, not a lifecycle package.

## Options

The handler is not an option — it is the `HttpHandler` port your module
provides. `httpRuntime` takes only what the socket needs:

| Option     | Default   |                                                                                                                               |
| ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `port`     | —         | required; `0` lets the OS pick — read the real one back from `RunningApp.runtimeInfo()`                                       |
| `hostname` | `0.0.0.0` | the deployment target is a pod, not a laptop; it also means the server is reachable beyond loopback — set `127.0.0.1` locally |

## Status codes the package itself writes

| Code  | When                                                |
| ----- | --------------------------------------------------- |
| `404` | the handler resolved without writing a response     |
| `500` | the handler failed, and no response was written yet |

A handler that hands back an `AsyncResult` carrying an `Err` or a `Defect`
**resolves** rather than rejects — an `AsyncResult` never rejects — so it lands
in the `404` branch, not the `500` one. That is correct, not a bug: this
package does not map `Result` → status, and a handler that returns an
unfolded `Result` has not answered the request.

"Failed" covers a rejected promise, a **synchronous** throw before anything
awaitable was returned, and a `StartOptions.unit` provider that failed to build
— the last two never reach the handler's own promise, so the `500` is written
from the unit's defect path instead. Once headers are already on the wire there
is no status left to write, and the last resort is destroying the socket — a
reset the client sees rather than a hang.

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

## License

[MIT](./LICENSE) © Benoit TRAVERS
