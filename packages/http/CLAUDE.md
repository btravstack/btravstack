# packages/http

The HTTP runtime's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/http/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`httpModule(options)` → `Module<HttpRuntime, never, never>`** — the
  runtime as a module: it provides `Runtime<typeof HttpHandler, HttpInfo>` on
  the **`HttpRuntime`** port (a class over core's `RuntimePort`), which the
  composition root imports next to the application and exports so `start`
  finds it. The runtime value's own factory, `httpRuntime`, is internal — not
  exported. The runtime binds `node:http`, one kernel unit per request.
  `HttpOptions` — `port` (required;
  `0` lets the OS pick, read back via `runtimeInfo()`), `hostname` (default
  `0.0.0.0` — a pod, not a laptop). `HttpInfo` is `{ port }`, published on
  `Serving.info` once bound. Its one need is `HttpHandler`, resolved out of
  **each unit's** context — so an application provides it at application
  scope, or in the `StartOptions.unit` module when the handler wants
  per-request dependencies constructor-injected (a handler is then built once
  per request; _"resolves a handler the unit module provides, built once per
  request"_ pins it). No `needs`, no `handler` option: the runtime declares
  what _it_ needs, and what the handler needs is the handler's provider's
  business. This is why the kernel's gate lets a runtime need come from
  `UnitX`.
- **`HttpHandler`** — a di `Port` whose service is
  `(request, response, signal) => PromiseLike<unknown>`.
  Returns the handled-or-not signal, not the response body: the package
  decides `404` (resolved without writing) or `500` (rejected before writing)
  from it, and never double-writes once headers are on the wire. A defect that
  never reaches the handler's promise — a synchronous throw, a
  `StartOptions.unit` provider failing to build — gets its `500` from the
  unit's `recoverDefect` instead, which destroys the socket only once headers
  are already out.
- **The guarantee**: the unit's lifetime **is** the response's — it does not
  close until the response's `'close'` event fires, and closes at once if that
  event already fired before the work ran (a client hanging up during a slow
  `StartOptions.unit` build; the unit's work is deferred behind the fork) — so
  there is no seam for a late write to land in, and `id: randomUUID()` is minted per request (a
  non-blank inbound `x-request-id` becomes `traceId`), so the two contracts a
  runtime owes (see above) are structural here rather than left to a caller's
  care.
- **Drain**: `stopAccepting` retires every open response — an unsent header
  gets `Connection: close`, a sent one ends its socket on `'finish'` — and
  `stop()` destroys what is still open. `closeIdleConnections()` alone would
  miss a response with a request in flight; that is why retirement is tracked
  per-response rather than left to it.
- **Not included, deliberately**: routing, middleware, `Result` → HTTP status,
  HTTPS, HTTP/2 — see the package README's _"What it does not do"_ for why
  each is a non-goal.
- Peer dependencies: `@btravstack/core`, `@btravstack/di`, `unthrown`.
