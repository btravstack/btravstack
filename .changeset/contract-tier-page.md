---
"@btravstack/contract": minor
---

`@btravstack/contract` is the contract tier rather than an auth-only package:
what a client and the server that implements it both need, and no transport
owns. A shape belongs here when both ends need it and no transport owns it.

The first shape beside the marker is a cursor page. The root, still with no
runtime dependencies, adds `Page<T>`, `PageRequest`, `PageQuery`, the `page`
constructor whose flags are derived from the cursors, and `pageRequest`, which
narrows a validated input into the one-direction request a port takes.
`@btravstack/contract/zod` adds `pageOf` and `pageRequestOf`, the schema half,
behind an optional `zod` peer on the same subpath protocol as
`@btravstack/cache/redis`.

A type test pins that what `pageOf` parses to is a `Page`, and a spec pins
that every page `page()` builds parses against `pageOf` — so the type a port
speaks and the schema a contract publishes cannot drift apart.
