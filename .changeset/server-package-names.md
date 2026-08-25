---
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

**Renamed.** `@btravstack/http` → `@btravstack/http-server`,
`@btravstack/temporal` → `@btravstack/temporal-worker`, and
`@btravstack/amqp` → `@btravstack/amqp-worker`.

Each package claimed a whole transport and delivered the serving half of it:
the calling half is `@orpc/client`, `@temporal-contract/client` and
`@amqp-contract/client` today, and will be a `-client` package in this family
later. Qualifying the name now reserves that space and matches the neighbours,
which qualify both sides (`@orpc/server` / `@orpc/client`).

"worker" rather than a uniform `-server` because it is Temporal's and AMQP's
own word — and because `temporal-server` already means the Temporal Service
itself.

To migrate: change the specifier. Nothing else moved — no export was renamed,
added or removed.

```diff
-import { HttpModule } from "@btravstack/http";
+import { HttpModule } from "@btravstack/http-server";
```
