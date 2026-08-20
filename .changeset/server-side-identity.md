---
"@btravstack/http": minor
---

Let a deployment state what its principal actually is, server-side, with
`httpAuth<Identity>()`.

The contract says **whether** a route is protected and names no identity type
at all. `httpAuth<Identity>()` is what says **what** the principal is: it mints
`HttpController`, `HttpRouter` and `HttpAuthenticator` together, all fixed to
that identity. Written once per application, because a handler's parameter
types are fixed where the arrow is written and a composition root cannot
re-type a `sync` callback living in another module; every slice then imports
`HttpController` from that one file and its marked handlers see `Identity` on
`context.principal` with no annotation of their own. The authenticator and the
controllers cannot disagree, since both come from the same call, and it is
handed back already applied (`HttpAuthenticator([deps], { sync })`).

It is also the only way a handler gets a readable principal: `HttpController`
and `HttpRouter` imported from the package itself name no identity, so a marked
fragment reached through them types `principal: never` and every read is a
compile error — the signal to use the factory, not a fallback. The contract
still decides _whether_: an unmarked procedure's context carries no principal,
factory or not.

`HttpModule`'s gate compares the **router's** identity against the
**authenticator's** — `AuthIdentity extends RouterIdentity`, so an
authenticator resolving more than the handlers read discharges it, while one
minted by a different `httpAuth` call does not. `ContractPrincipal` is replaced
by `HasMark<C>`, exactly `true` or `false`, which is all the conditional
authenticator dependency ever needed.

Also exported: `HttpAuth<Identity>` and the three `HttpControllerOf` /
`HttpRouterOf` / `HttpAuthenticatorOf` aliases, which a file exporting what the
factory returns needs to annotate with.
