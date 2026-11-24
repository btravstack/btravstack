---
"@btravstack/observability": minor
---

`diagnosticPolicy` accepts a `"uuid"` field rule beside finite vocabularies and
numeric bounds. A field declared `"uuid"` keeps a string in the canonical UUID
form and drops any other value, on log attributes and `cause` attributes alike,
so a production line can name the entity it is about by an opaque identifier:

```ts
diagnosticPolicy({ fields: { accountId: "uuid" } });
```

Undeclared fields and the existing rules behave as before.
