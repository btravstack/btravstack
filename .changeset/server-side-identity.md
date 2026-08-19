---
"@btravstack/http": minor
---

Let a deployment state what its principal actually is, server-side, with
`httpAuth<Identity>()`.

A contract declares the client-visible **minimum** — often `{ tenantId }` — and
says _whether_ a route is protected. What an authenticator resolves is usually
more, and until now a handler could not see the extra fields: their type was
read off the contract, so the richer object that was there at runtime reached
the handler only through a cast.

`httpAuth<Identity>()` mints `HttpController`, `HttpRouter` and
`HttpAuthenticator` together, all fixed to that identity — the server-side
mirror of `auth<P>()` on the contract side. It is written once per application,
because a handler's parameter types are fixed where the arrow is written and a
composition root cannot re-type a `sync` callback living in another module;
every slice then imports `HttpController` from that one file and its marked
handlers see `Identity` on `context.principal` with no annotation of their own.
The authenticator and the controllers cannot disagree, since both come from the
same call, and it is handed back already applied
(`HttpAuthenticator([deps], { sync })`).

The contract still decides _whether_: an unmarked procedure's context carries no
principal, factory or not, and `HttpModule`'s gate is unchanged — it still
checks the authenticator against the contract's own `Principal`, which a richer
`Identity` discharges as a subtype. `HttpController` and `HttpRouter` imported
from the package behave exactly as before.

Also exported: `HttpAuth<Identity>` and the three `HttpControllerOf` /
`HttpRouterOf` / `HttpAuthenticatorOf` aliases, which a file exporting what the
factory returns needs to annotate with.
