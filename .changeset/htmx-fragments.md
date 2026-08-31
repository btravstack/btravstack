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

htmx fragments: a second `HttpHandler` answerer, serving `Html` escaped by default.

`html`/`raw` (`Html`, an object rather than a bare string) escape every
interpolation by default; `raw(markup)` is the one way past the escaping, a
visible act at the call site. The escaping is context-blind: it protects
element text and a quoted attribute value, and nothing else — an unquoted
attribute, an attribute name, a URL scheme and `<script>`/`<style>` contents
are the caller's own responsibility.

`defineFragments({ … })` declares a fragment contract — a flat record of
`{ method, path, input? }` routes, carrying `@btravstack/contract`'s
`authenticated()` marker unchanged, so a route gets the same principal and the
same 401/403 path as a procedure. It is **not** an oRPC contract: a browser
navigation is not an RPC call, so a route answers `Html` rather than a typed
envelope, and its errors are the slice's own to recover into a rendered
fragment rather than a declared union a client branches on. `ParamsOf<Path>`
extracts a path template's `:name` segments at the type level.

`api.HtmxController(fragments, key)({ name: Dep }, { sync })` and
`api.HtmxFragments(fragments)([piece, …])` mirror `HttpController`/`HttpRouter`
— one route as a provider on a port of its own, composed from an array of
pieces, an uncovered route refused at the call. `htmx({ prefix? })` is the
answerer, a second `HttpHandler` member alongside `orpc()`.

`HttpModule({ router?, fragments?, fragmentsPrefix?, … })` composes a router,
fragments, or both — supplying neither is refused at the call against a
"SERVES NOTHING" gate. A scheme shared between the two is deduplicated by
reference before it reaches `provides`.

Two limitations ship stated rather than discovered: the POST body decodes
through `Object.fromEntries`, so a `<select multiple>` or a checkbox group
keeps only the last value; and route order is the composition root's — an
unmarked route declared before a marked route whose path can also match the
same request answers it, with no authentication run.
