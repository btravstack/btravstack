---
"@btravstack/prisma": patch
---

Support Prisma 8 from `8.0.0-rc.11` again (#641). The `@prisma/orm-postgres`
peer is back to `^8.0.0-rc.11`, and the query middleware carries the hooks of
both trains: `beforeQuery`/`afterQuery`/`beforeExecute`/`afterExecute` up to
rc.17, `beforeEncode`/`activityEnded` from rc.18. Each runtime calls its own.
An application with migrations released under rc.11 upgrades this package
without touching Prisma, its migrations or its database markers, and upgrades
Prisma later on its own schedule.
