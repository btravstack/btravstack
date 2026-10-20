---
"@btravstack/prisma": minor
---

Adopt Prisma Postgres 8.0.0-rc.18 with CLI 8.0.0-rc.23 and CLI engine 0.7.0.
Migrate query observation to SQL encoding and activity-completion hooks. The
Postgres peer now requires rc.18 and its temporal-polyfill peer. Existing
applications must convert their stored contracts and re-sign database markers
following Prisma's upgrade instructions before deployment.
