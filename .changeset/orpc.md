---
"@btravstack/orpc": minor
---

The oRPC starter for `@btravstack/http`. `orpc(RouterPort, { prefix? })` is a
provider of `HttpHandler` built from a **router port** — the application
provides its oRPC router as a service (a provider that declares the use cases
its procedures call) and this turns it into the HTTP surface: Hono owns routing
and the fetch idiom, oRPC's fetch adapter is mounted under `prefix` (default
`/rpc`), an unmatched path is Hono's 404 and a defect inside a procedure is
oRPC's own `INTERNAL_SERVER_ERROR` collapse. `getRequestListener` runs with
`overrideGlobalObjects: false`. A port whose service is not a router `RPCHandler`
can serve with no initial context fails to typecheck at the `orpc(...)` call.
