---
"@btravstack/core": minor
"@btravstack/cache": minor
"@btravstack/config": minor
"@btravstack/mailer": patch
"@btravstack/testing": patch
---

Made the probe server reachable, gave health checks a deadline, and closed four
ways an adapter or a config field failed dishonestly.

**The probe server binds `0.0.0.0` by default**, from the new `PROBE_HOST` /
`probes: { host }` — `HOST`'s own default for `HOST`'s own reason. It bound
`127.0.0.1` only, which a kubelet `httpGet` probe cannot reach because it
connects over the pod IP; the deploy guide showed exactly that shape and it
could never have worked. Pin `127.0.0.1` where the port is shared, and probe it
with `exec` from inside the container.

**`runHealthChecks` bounds each check**, at `DEFAULT_HEALTH_TIMEOUT_MS` (`800`,
under kubelet's own `timeoutSeconds` default of `1`) or a per-contribution
`HealthCheck.timeoutMs`. A check that never settled held a socket open per hit
on `/healthz` while the orchestrator timed out against a report naming nothing;
now the component that hung is named like any other unhealthy one.
`@btravstack/mailer` declares `timeoutMs` on its contribution and its
hand-rolled race is gone.

**`@btravstack/cache/redis`** carries a permanent `'error'` listener, so a
socket drop no longer reaches the kernel's `uncaughtException` handler as a
whole-application teardown at exit `70`. A `REDIS_URL` nothing answers is now
`CacheConnectionFailed` after five attempts rather than a build that hangs
forever — node-redis retries the first connect without limit, which under a
kernel still `building` is a pod answering `/livez` and never `/readyz`. A
value another writer left under a key is a `CacheUnavailable` rather than a
defect `getOrSet` could not recover, and a value `JSON.stringify` refuses is a
defect on the returned channel rather than a synchronous throw out of `set`.

**`ttlMs` means one thing for every adapter.** `readThrough` rounds it to whole
milliseconds and stores nothing below `1`, so a computed `deadline - now` that
has gone negative is a miss on both adapters — where the memory one stored
forever and the Redis one reported `PX 0` as `CacheUnavailable`, an outage
class, for a bug in the caller.

**`@btravstack/config`**: a malformed URL's message redacts its userinfo, so a
`DATABASE_URL` password no longer reaches stderr through `runMain`'s
`startFailed` line; a field whose `parse` throws is folded into an issue
instead of escaping a `validate` this package promises never throws;
`Config.list(v, { default: [] })` is accepted, `min` defaulting to `0` when a
default is given rather than blaming a variable nobody set; and `integer` /
`port` read decimal only, so `PORT=0x1F90` is named rather than silently bound
as `8080`.
