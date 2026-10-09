---
"@btravstack/prisma": minor
---

`prismaDatabase` probes the database while the scope opens, before the client is handed out. A fresh pool no longer deadlocks when its first statements are a burst of concurrent transactions at least as large as the pool, and a database that does not answer fails the boot with the new `DatabaseUnreachable` instead of failing the first request.
