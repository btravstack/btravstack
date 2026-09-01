# CLAUDE.md — @btravstack/cache

The application-service port for caching: a `Cache` an application depends on,
adapters that provide the `CacheBackend` behind it, and one composition
function that binds them together, with every call reported through
counted and logged.

It is a plain di port. No kernel change, no runtime, no thesis exemption —
which is what issue #62 said these should be.

## Public surface

Stated once, here.

### `@btravstack/cache` (root)

| Export                            | What it is                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Cache`                           | The port an application depends on. `get` / `set` / `delete`, all `AsyncResult`.                                                                                         |
| `CacheBackend`                    | The port every adapter provides. Not for application code — see **Why two ports** below.                                                                                 |
| `CacheService`                    | The service both ports carry.                                                                                                                                            |
| `CacheHit`                        | `{ readonly value: unknown }` — what a `get` answers on a hit.                                                                                                           |
| `CacheUnavailable`                | The modeled failure: `{ operation: "get" \| "set" \| "delete"; key: string }`.                                                                                           |
| `cache({ adapter })`              | The composition: the adapter's module, plus `Cache` provided from its backend, every call handed to `Observers`. The module owes nothing beyond its adapter's own needs. |
| `CacheOptions`                    | `{ adapter: Module<CacheBackend, E, N> }`.                                                                                                                               |
| `memoryCache({ clock? })`         | The in-memory adapter as a module.                                                                                                                                       |
| `memoryCacheProvider({ clock? })` | The same adapter as a provider — the shape `overridden` takes.                                                                                                           |
| `memoryCacheBackend({ clock? })`  | The service itself, for a spec that wants no graph.                                                                                                                      |
| `MemoryCacheOptions`              | `{ clock?: Clock }`, defaulting to the kernel's `systemClock`.                                                                                                           |

### `@btravstack/cache/redis`

| Export                      | What it is                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `redisCache()`              | The Redis adapter as a module: `REDIS_URL` through `Config`, one connection on the scope. |
| `redisCacheBackend(client)` | The service over a connected `RedisClientType`.                                           |
| `CacheConfig`               | The port the URL is bound onto.                                                           |
| `redisSchema`               | The `Config.object` behind it — one required `REDIS_URL`.                                 |

`redis` is an **optional** peer: a consumer that never imports this subpath
never installs it, exactly like `@btravstack/observability/pino`.

## Why two ports

di allows **one provider per port per graph**. So the port an application
depends on must not be the port an adapter provides: `Cache` and
`CacheBackend` carry the same service, an adapter targets the second, and
`cache()` is the seam that turns it into the first.

The rule bites hardest on the observed wrapper — it cannot be layered
over a module that already provides `Cache`, because that is two providers
for one port — which is why the wrapper is applied by **the composition**
rather than a decorator applied to it. The composition builds one graph or
the other; nothing wraps anything after the fact.

It is also the seam a spec overrides: `overridden(root, [memoryCacheProvider()])`
replaces the Redis adapter under the real root, and the drift gate comes free
(an override for a port the tree stopped providing is a `WiringDefect`).

## Decisions

- **A miss is `Ok(undefined)`, and a hit is a one-field record.** Absence is
  the cache working. `CacheHit` exists so a cached `null` and a key nobody set
  stay different facts.
- **`CacheUnavailable` is modeled, and recovering it is the caller's job.**
  Whether an outage degrades a request to a miss or fails it depends on what
  the value is for; `examples/order-api`'s customers controller shows the
  degrade, recovered at the call.
- **Values are `unknown`, encoded by the adapter.** Redis stores JSON; the
  memory adapter stores the reference it was given, which is the honest
  difference rather than a deep-cloning fake. A value `JSON.stringify` cannot
  take is a **defect**, not a modeled error — a bug in the caller, and an arm
  no correct program could reach.
- **Keys are plain strings, and the caller composes them.** A namespace or
  tenant parameter would put a tenancy model in a package with no business
  holding one — the framework has no concept of a tenant anywhere (root
  `CLAUDE.md`). The example's key carries its tenant by hand, and says so.
- **The memory adapter expires lazily, on read.** A sweeping timer would keep
  the event loop alive, which a kernel built around a process that can end has
  no business doing.
- **The Redis connection is a private port.** A resourceful provider is handed
  back the service it acquired, and a cache's three methods are not something
  you can close — so the client rides the graph as `RedisConnection`, the same
  move `@btravstack/observability`'s `OtelSdk` makes, and the scope closing is
  what closes the socket.
- **The observing wrapper is transparent to the `Result`** — the kernel's
  own `RunUnit` rule one layer down — and taps `tapFailure`, not an Err-only
  tap, so a defect ends its span too.
- **Keys ride spans and log lines; values never do.** A cached value is
  application data this package cannot read.

## Deliberately not here

- **No `getOrSet`.** Stampede semantics — lock, early recompute, serve-stale —
  differ per application, and the two-line read-through the example writes is
  clearer than a combinator with a policy in it.
- **No eviction and no maximum size on the memory adapter.** A process caching
  unbounded keys grows unbounded; the upgrade path is Redis, which is what a
  deployment with that problem should be running.
- **No invalidation strategy, no tags, no `clear()`.** Keys are the caller's,
  and a package that cannot compose them cannot invalidate by pattern either.
- **No multi-get, no counters, no lists.** One value at a time, on the three
  operations every backend has.
- **No namespace parameter, and no `keyPrefix` either — for two different
  reasons.** A per-call namespace is the tenancy question one layer out, and
  the framework has no concept of a tenant to put in that slot. A
  deployment-level `keyPrefix`, for two applications sharing one server, is
  the reasonable version of the ask and is declined because **Redis already
  has it**: `REDIS_URL` carries a database index as its path and node-redis
  honours it (measured against the gate's own container — a key written on
  `…/3` is absent on `…/4`), so separating two applications is a deployment
  change with no code. A prefix would be the weaker of two ways to do one
  thing: it does not isolate `FLUSHDB`, `SCAN` or `DBSIZE`, and a database
  does. **The caveat**: Redis Cluster has only database 0, so a clustered
  deployment genuinely cannot use the URL for this — that is the day
  `keyPrefix` earns its place, and not before (issue #62's own "not built
  speculatively"). Tests need none of it: a UUID key prefix per test is the
  isolation boundary, and it needs no package support.

## Testing

`packages/cache` needs a **Docker daemon**: its Redis specs run against the
shared `redis:8.8.2-alpine` in `internal/test-infra`, and isolate by a UUID key
prefix per test — nothing is flushed, nothing is cleaned up. The memory
adapter's TTL is asserted on a `createFakeClock`; the one real wait in the
package is Redis's own expiry, which is the server's clock and not this
process's.

Coverage is 100% lines/functions, `test-fixtures.ts` excluded.
`src/module.test-d.ts` pins the needs gate: a root composing
a cache without `observability()` and `otel()` beside it fails
di's `UNSATISFIED DEPENDENCIES` gate naming `Logger | Meter | Tracer`.

## Health check

The starter contributes one `HealthChecks` member, named `cache`, so the
kernel's `/healthz` reports on it without the application wiring anything. The
probe is a `get` on a reserved probe key — a MISS is the cache working, so only the adapter reporting it could not reach the server is unhealthy.

Composing the starter therefore exports `HealthChecks` alongside its own port —
a composition root that re-exports the module whole passes it up to the kernel
with no extra line.

## Observation is a set port, not a flag

Every call this package makes observable is handed to whatever contributed to
`Observers` — `@btravstack/core`'s set port — and this module contributes a
**no-op member of its own**, so a graph composing no observability owes nothing,
installs nothing — an operation costs one inert call per module that reads the port.

`instrumented` is gone. It defaulted to `true` and therefore put `Logger`,
`Meter` and `Tracer` in this module's `Needs`, so a root that wanted a cache and
no OpenTelemetry SDK got a compile error naming three ports and had to find an
option to turn something off it never asked for. A set port has the property the
flag was reaching for and the flag could not have: **on when observability is
composed, free when it is not, and one composition either way.**

**A reader of the port must contribute a member**, the way `otel()` does for
`Instrumentations`: a collector depending on a set port nothing provides is an
unmet dependency, at plan time and in `Needs` alike. Several no-ops in one graph
cost a call each.

**Dimensions and details are separate, and that split is what lets one observer
serve every component.** `attributes` are bounded and ride the instruments;
`details` are unbounded — a cache key, a mail subject, a URL — and ride the span
and the error line only. Without it every contributor would have to choose
between a useful span and a safe metric.

What the observers do with an operation belongs to `@btravstack/observability`:
`observability()` writes a line when one FAILS (never on success — that is what
the metric is for), and `otel()` opens the span and mints
`btravstack.<component>.operations` and `btravstack.<component>.duration`. The
names are derived from the operation's own `component`, so nothing had to become
uniform to be shared.
