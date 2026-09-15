# CLAUDE.md — @btravstack/cache

The application-service port for caching: a `Cache` an application depends on,
adapters that provide the `CacheBackend` behind it, and one composition
function that binds them together, with every call reported through
counted and logged.

It is a plain di port. No kernel change, no runtime, no thesis exemption —
which is what issue #62 said these should be.

## Public surface

The exports are `src/index.ts` and `src/redis.ts` (`@btravstack/cache/redis`),
each with its TSDoc; `docs/reference/cache.md` is the reader's page.

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

The TSDoc of `src/cache.ts`, `src/memory.ts`, `src/redis.ts` and
`src/instrument.ts` states the rest: a miss is `Ok(undefined)`, who recovers
`CacheUnavailable`, values and keys, lazy expiry, the private connection port,
and a wrapper transparent to the `Result`.

- **`getOrSet` is derived, never implemented.** `readThrough` builds it over
  `get`/`set` inside `cache()`, so an adapter still writes three methods and
  the policy has exactly one copy. It also sits OUTSIDE the observing wrapper's
  reach by construction: the `get` and the `set` it makes are the observed
  ones, so a read-through emits the hit or miss it really performed rather than
  a fourth operation nobody's dashboard knows.

## Deliberately not here

- **No stampede protection.** `getOrSet` is a read-through and nothing more:
  a hundred concurrent misses run a hundred loaders. Locking, early recompute
  and serve-stale differ per application and each needs state this port does
  not have; the day one of them is wanted it is a named option, not a default
  that changed under everybody.
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

Observation: see the root `CLAUDE.md`, **Observability is a set port, never a flag**.
