# packages/http

The HTTP runtime's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/http/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`httpRuntime(options)` → `Runtime<Needs, HttpInfo>`** — binds `node:http`,
  one kernel unit per request. `HttpOptions<Needs>` — `port` (required; `0`
  lets the OS pick, read back via `runtimeInfo()`), `hostname` (default
  `0.0.0.0` — a pod, not a laptop), `needs`, `handler`. `HttpInfo` is
  `{ port }`, published on `Serving.info` once bound.
- **`HttpHandler<Needs>`** —
  `(request, response, ctx: Context<InstanceType<Needs>>, signal) => PromiseLike<unknown>`.
  Returns the handled-or-not signal, not the response body: the package
  decides `404` (resolved without writing) or `500` (rejected before writing)
  from it, and never double-writes once headers are on the wire.
- **The guarantee**: the unit's lifetime **is** the response's — it does not
  close until the response's `'close'` event fires — so there is no seam for a
  late write to land in, and `id: randomUUID()` is minted per request (a
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
