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

`api.HtmxGet(path, options?)` and `api.HtmxPost(path, options?)` mint a route
straight from its path — no contract in between. `options.requires`, typed
exactly as an oRPC procedure's `authenticated()` mark, gives a route the same
principal and the same 401/403 path as a procedure. It is **not** an oRPC
contract: a browser navigation is not an RPC call, so a route answers `Html`
rather than a typed envelope, and its errors are the slice's own to recover
into a rendered fragment rather than a declared union a client branches on.
`HtmxPost` additionally takes `options.input`, the Standard Schema that
validates the decoded form body. `ParamsOf<Path>` extracts a path template's
`:name` segments at the type level.

`api.HtmxFragments([piece, …])` composes an array of `HtmxGet`/`HtmxPost`
pieces into one port, keyed by index. `htmx({ prefix? })` is the answerer, a
second `HttpHandler` member alongside `orpc()`.

`HttpModule({ router?, fragments?, fragmentsPrefix?, … })` composes a router,
fragments, or both — supplying neither is refused at the call against a
"SERVES NOTHING" gate. A scheme shared between the two is deduplicated by
reference before it reaches `provides`; `HttpModuleOptions`'s leading generic
parameters go from three (`RouterError, RouterNeeds, Auth`, when `router` was
required) to two (`Router, Fragments`, both optional) for this.

Limitations ship stated rather than discovered: the POST body decodes through
`Object.fromEntries`, assumed `application/x-www-form-urlencoded` with no
`content-type` check, so a `<select multiple>` or a checkbox group keeps only
the last value and a JSON body reads as one garbage key; route order is the
composition root's — an unmarked route declared before a marked route whose
path can also match the same request answers it, with no authentication run;
a route always answers `200` on success, so `HX-Redirect`, `HX-Trigger`,
`HX-Retarget` and `HX-Reswap` are unreachable and a route cannot answer its
own `404` or `422`; and every `200` carries `Cache-Control: no-store`,
unconditional, since the package has no way to know a route's output is safe
for a shared cache to keep.
