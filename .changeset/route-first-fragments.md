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

htmx fragments: the contract kind is deleted, routes declare themselves.

`defineFragments`, `FragmentRoute`, `FragmentsContract` and
`api.HtmxController(fragments, key)` are gone. A contract earns a package
when a client consumes it — an oRPC procedure gets one because `@orpc/client`
reads it to build a typed call. A fragment has no client: a browser navigates
and htmx swaps the response in, so there was never a consumer for the shape
to serve.

`api.HtmxGet(path, options?)` and `api.HtmxPost(path, options?)` mint a route
straight from its path, `options.requires` typed exactly as an oRPC
procedure's mark; `HtmxPost` also takes `options.input`, the Standard Schema
that validates the decoded form body (`GET` has no `input` field at all).
`api.HtmxFragments([piece, …])` composes an array of them, keyed by index
rather than a contract's key space.

Two gaps the contract shape carried are closed by this shape rather than
patched: an ungrantable scope on `requires` now fails the same
`"UNGRANTABLE SCOPE"` compile-time check an oRPC contract gets, checked at
each route's own mint instead of only at runtime (#184) — narrowly: the gate
fires on the literal `requires` given at the mint, and a value first widened
to `Requirements`, or a route record hand-built without the factories,
bypasses it and falls back to the runtime walk, a `403` rather than an
admission; and a piece minted over a marked route composed under an
unrelated unmarked slot has no second contract instantiation left to
construct it from, so that hole closes by construction rather than by a new
gate (#185).
