---
"@btravstack/start-http": minor
---

The HTTP runtime for `@btravstack/start-core`.

`httpRuntime({ port, needs, handler })` owns an HTTP server's lifecycle and
nothing else: it binds (publishing the real port on `Serving.info`, so
`port: 0` is usable), opens one kernel unit per request, drains by genuinely
refusing new work, and stops by destroying what is left.

Its guarantee is that every request produces exactly one completed response,
and the unit stays open until that response is on the wire — which makes the
kernel's least-checkable contract structural rather than documented. Routing,
middleware and `Result` → HTTP status are deliberately not included: bring
oRPC, Hono, or a bare function.
