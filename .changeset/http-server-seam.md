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

The authentication walk and the socket half are reusable by a second answerer.

`resolvePrincipal(requirements, authenticators, headers)` is the walk oRPC's
`principalMiddleware` used to hold — requirements in declared order, the scope
comparison, the grant brand test — answering an `AsyncResult` instead of
calling oRPC's `next()`. `principalMiddleware` is now the oRPC adapter over it.
A second protocol therefore shares one scope check rather than copying it.

`httpServer(options)` is the socket, runtime and configuration with **no**
answerer; `http(options)` is `httpServer(options)` plus `orpc(options)` and is
unchanged in both behaviour and signature. This is what makes a graph serving
only fragments expressible: it would otherwise have had to compose `http()`
and declare an oRPC router it does not have.

`UnderScoped` is exported: the `403` case, distinct from `Unauthenticated`'s
`401`. It was already tracked inside the walk and collapsed at the end.
