---
"@btravstack/di": minor
"@btravstack/config": minor
"@btravstack/core": minor
"@btravstack/testing": minor
"@btravstack/observability": minor
"@btravstack/cache": minor
"@btravstack/mailer": minor
"@btravstack/storage": minor
"@btravstack/prisma": minor
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

feat(di)!: a provider declares its dependencies as a required `inject` key

`Provider(Port)(deps, arm)` is now `Provider(Port)({ inject: deps, ...arm })`,
one signature instead of two overloads discriminated by argument count. Every
mint built on it moves with it — `Provider.member`, `Config.provider`,
`api.OrpcController`, `api.OrpcRouter`, `api.HtmxGet`/`HtmxPost`,
`HttpAuthenticator`, `AmqpHandler`/`AmqpHandlers`,
`TemporalWorkflowActivities`/`TemporalActivities`. The array-of-pieces arm on
the three composing forms is unchanged.

`inject` is **required**. Optional, a mistyped key (`injec:`) is not caught by
excess-property checking inside the arm union, so it would silently become a
no-deps provider and fail later as di's unmet-dependency defect instead of at
the call; required, the diagnostic names the property. A provider with no
dependencies writes `inject: {}`, and its factory is handed one empty services
record rather than no arguments.

Migration is mechanical:

```diff
-Provider(OrderRepository)(
-  { db: OrderDatabase },
-  { sync: ({ db }) => prismaOrderRepository(db) },
-);
+Provider(OrderRepository)({
+  inject: { db: OrderDatabase },
+  sync: ({ db }) => prismaOrderRepository(db),
+});

-Provider(AppConfig)({ value: { dbUrl } });
+Provider(AppConfig)({ inject: {}, value: { dbUrl } });
```
