# packages/orpc

The oRPC starter's public surface. The root `CLAUDE.md` is the authoritative
spec; this file holds what only matters under `packages/orpc/`. Keep it in
sync with the code and `README.md` in the same commit — the package ships no
`docs-examples.test-d.ts`.

## Public surface

- **`orpc(RouterPort, options?)` → `Provider<HttpHandler, never, RouterPort>`**
  — a provider of `@btravstack/http`'s `HttpHandler` port, declaring the router
  port as its one dependency. Inside: `new RPCHandler(router)` from
  `@orpc/server/fetch`, mounted on a Hono app under `options.prefix` (default
  `/rpc`) with `app.all(`${prefix}/*`)` that falls through to `next()` when oRPC
  does not match, bridged onto the node pair by `@hono/node-server`'s
  `getRequestListener(app.fetch, { overrideGlobalObjects: false })`.
- **`RouterPort` is constrained at the call site**: the parameter is
  `R & RouterPort<R>`, where `RouterPort<R>` is `unknown` when `ServiceOf<R>
extends Router<Record<never, never>>` and `never` otherwise — so a port whose
  service is not a router, or a router that declares an initial context this
  starter cannot supply, fails to typecheck rather than at the first request.
- **`OrpcOptions`** — `{ prefix?: `/${string}` }`.
- **Not included, deliberately**: `Result` → status (that is the router's
  `.result()` triage, `@unthrown/orpc`), routing beyond the one mount, and any
  Hono middleware — an application that wants either writes its own
  `Provider(HttpHandler)`.
- Peer dependencies: `@btravstack/core`, `@btravstack/di`, `@btravstack/http`,
  `hono`, `@hono/node-server`, `@orpc/server`, `unthrown` — a starter has real
  dependencies (that is what makes it a starter), all peers so an application
  holds one copy of each.

## Tests

`orpc.spec.ts` (6 specs) boots a real `http({ port: 0 })` app with a router
provided over a `Greeter` port and drives it with `@orpc/client`'s `RPCLink`:
served with injected deps, mounted under a custom prefix, Hono's 404 off-prefix
and on an unknown procedure, oRPC's `INTERNAL_SERVER_ERROR` collapse, and
`globalThis.Response` untouched after a request. Fixtures in
`src/test-fixtures.ts`; coverage 100% lines/functions.
