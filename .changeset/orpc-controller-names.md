---
"@btravstack/amqp-worker": minor
"@btravstack/cache": minor
"@btravstack/config": minor
"@btravstack/contract": minor
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/http-server": minor
"@btravstack/mailer": minor
"@btravstack/observability": minor
"@btravstack/prisma": minor
"@btravstack/storage": minor
"@btravstack/temporal-worker": minor
"@btravstack/testing": minor
---

`HttpController` and `HttpRouter` are renamed `OrpcController` and `OrpcRouter`.

A name is qualified by the half it implements — the rule that made the package
`http-server` rather than `http`, applied one level down. `HttpHandler` became a
set port carrying several protocols, and the oRPC pieces were the only ones
still claiming the umbrella: the answerer factories were already `orpc()` and
`htmx()`, and the htmx pieces were already `HtmxGet`/`HtmxPost`/`HtmxFragments`,
while the oRPC pieces read as the transport's own. `HttpRouterPort` held an
oRPC `Router` — the HTTP router is `HttpHandler`, which routes each request to
the answerer whose prefix matches longest.

The line the rename draws: `Http*` is the **transport** — `HttpRuntime`,
`HttpModule`, `HttpConfig`, `HttpHandler`, `defineHttp`, `http()`, all
unchanged — and a protocol prefix is **one answerer's pieces**,
`OrpcController`/`OrpcRouter` beside `HtmxGet`/`HtmxPost`/`HtmxFragments`, and
whatever GraphQL brings next.

Migration is two identifiers, including the di port id `"HttpRouter"` and the
controller port-id prefix `"HttpController:"`, which become `"OrpcRouter"` and
`"OrpcController:"`:

```text
api.HttpController(contract, path)  →  api.OrpcController(contract, path)
api.HttpRouter(contract)([…])       →  api.OrpcRouter(contract)([…])
HttpRouterPort                      →  OrpcRouterPort
ControllerKeyOf / ControllerPortOf  →  unchanged
```

The `"UNCOVERED CONTROLLERS — …"` and `"OVERLAPPING CONTROLLERS — …"` gate
markers are unchanged: only the `Http` prefix was the lie, "controller" was
never one.
