---
"@btravstack/contract": minor
"@btravstack/di": minor
"@btravstack/config": minor
"@btravstack/core": minor
"@btravstack/testing": minor
"@btravstack/observability": minor
"@btravstack/http": minor
"@btravstack/temporal": minor
"@btravstack/amqp": minor
---

A contract may name a scope only if its scheme can grant it

`HttpRouter(contract)` now refuses a contract declaring a scope outside the
vocabulary its scheme's authenticator was minted with, and the diagnostic ends
on the offending scope:

```
Property '"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"' is
  missing in type 'Authenticated<…, [{ user: ["order:export"] }]>' but required
  in type '{ readonly "UNGRANTABLE SCOPE — …": "order:export"; }'
```

Before this, nothing tied a contract's scope **strings** to what a scheme could
actually grant. A typo — or a scope asked of a scheme declared with no
vocabulary at all — compiled, passed every check, and then refused every caller
on that route with a permanent `403` and no diagnostic anywhere.

A requirement naming no scopes costs nothing, which is the common case. The
check is the sibling of the scheme-**name** check di already performs by leaving
an unknown scheme's port unmet.
