---
"@btravstack/http-server": patch
"@btravstack/temporal-worker": patch
"@btravstack/amqp-worker": patch
---

The README install lines now pin the beta majors. `@orpc/*`,
`@temporal-contract/*` and `@amqp-contract/*` each ship a `latest` dist-tag
pointing at an older major, so the unversioned line installed the wrong one and
the first run failed in type errors.
