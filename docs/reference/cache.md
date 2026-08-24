---
title: "@btravstack/cache"
description: The complete surface of @btravstack/cache — the Cache and CacheBackend ports, CacheUnavailable, the memory and Redis adapters, cache(), instrumentedCache() and REDIS_URL.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { Cache, CacheBackend, cache, memoryCache, memoryCacheProvider, type CacheService } from "@btravstack/cache";
import { instrumentedCache } from "@btravstack/cache/instrumented";
import { redisCache } from "@btravstack/cache/redis";
import { observability, Logger } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { createFakeClock, overridden } from "@btravstack/testing";
import { OkAsync, P, type AsyncResult } from "unthrown";

// The stand-ins the fences below read: a graph an application already
// composed, and the view its own layer defines.
declare const RealApp: Module<Cache, never, never>;
type CustomerView = { readonly id: string; readonly name: string };
declare const findCustomer: (id: string) => AsyncResult<CustomerView, never>;
-->

# @btravstack/cache

> **Reference.** A complete, structured description of `@btravstack/cache`:
> the `Cache` port an application depends on, the `CacheBackend` every adapter
> provides, the modeled `CacheUnavailable`, the in-memory and Redis adapters,
> and the two compositions — plain and instrumented — that turn one into the
> other.

## The port

```ts
class Customers extends Port("ReferenceCustomers")<{
  readonly find: (id: string) => AsyncResult<CustomerView, never>;
  readonly forget: (id: string) => AsyncResult<void, never>;
}> {}

export const customersProvider = Provider(Customers)(
  { cache: Cache },
  {
    sync: ({ cache }) => ({
      find: (id) =>
        cache
          .get(`customers:${id}`)
          .recoverErrCases((m) =>
            m.with(P.tag("CacheUnavailable"), () => undefined),
          )
          .flatMap((hit) =>
            hit === undefined
              ? findCustomer(id).flatTap((found) =>
                  cache
                    .set(`customers:${id}`, found, { ttlMs: 60_000 })
                    .recoverErrCases((m) =>
                      m.with(P.tag("CacheUnavailable"), () => undefined),
                    ),
                )
              : OkAsync(hit.value as CustomerView),
          ),
      forget: (id) =>
        cache
          .delete(`customers:${id}`)
          .recoverErrCases((m) =>
            m.with(P.tag("CacheUnavailable"), () => undefined),
          ),
    }),
  },
);
```

| Method                        | Answers                                                |
| ----------------------------- | ------------------------------------------------------ |
| `get(key)`                    | `AsyncResult<CacheHit \| undefined, CacheUnavailable>` |
| `set(key, value, { ttlMs? })` | `AsyncResult<void, CacheUnavailable>`                  |
| `delete(key)`                 | `AsyncResult<void, CacheUnavailable>`                  |

Three things the signatures decide:

**A miss is `Ok(undefined)`.** Absence is the cache working, not failing, so
nothing has to triage a "not found" that was never an error.

**A hit is `{ value }`, not the value.** A cached `null` and a key nobody set
are different facts, and one `undefined` cannot carry both.

**The value is `unknown` in both directions.** The adapter encodes it — Redis
stores JSON — and claiming what came back is yours, once, where the value
re-enters your application's vocabulary:

```ts
export const viewOf = (
  hit: { readonly value: unknown } | undefined,
): CustomerView | undefined =>
  hit === undefined ? undefined : (hit.value as CustomerView);
```

A value `JSON.stringify` cannot take — a cycle, a `BigInt` — is a **defect**,
not a `CacheUnavailable`: it is a bug in the caller rather than an operational
state, and modelling it would put an arm on every call site no correct program
can reach.

## `CacheUnavailable`, and who recovers it

`CacheUnavailable` carries `{ operation, key }` and means the backend could
not answer — the connection is down, the server refused the command.

It is modeled rather than swallowed because **the recovery is yours**: whether
an unreachable cache degrades the request to a miss or fails it depends on
what the cached value is for, and a package that decided one way would be
deciding for every application at once. The usual answer, spelled at the call:

```ts
export const readOrMiss = (cache: CacheService, key: string) =>
  cache
    .get(key)
    .recoverErrCases((matcher) =>
      matcher.with(P.tag("CacheUnavailable"), () => undefined),
    );
```

## Keys are yours

Keys are plain strings and nothing composes them for you. There is no
namespace parameter and no tenant slot: the framework has no concept of a
tenant anywhere — every port that needs one names it, and a cache is an
application service — so a multi-tenant application writes the tenant into the
key itself:

```ts
export const keyFor = (tenantId: string, id: string): string =>
  `customers:${tenantId}:${id}`;
```

## The two ports

An adapter provides **`CacheBackend`**. A composition provides **`Cache`** from
it. They carry the same service, and the split is not decoration: di allows one
provider per port per graph, so an instrumented composition cannot be a layer
over a module that already provides `Cache`. Two compositions over one adapter
is what that leaves — and it makes instrumentation a decision visible at the
composition root rather than a flag.

`CacheBackend` is also the seam a spec overrides:

```ts
export const withMemory = overridden(RealApp, [memoryCacheProvider()]);
```

## Adapters

### `memoryCache({ clock? })`

A `Map` in the process, expiring **lazily on read** — a sweeping timer would
keep the event loop alive, which a kernel built around a process that can end
has no business doing. `clock` defaults to the kernel's `systemClock`; a spec
passes a fake one and asserts an expiry without waiting:

```ts
export const fixtureCache = memoryCache({ clock: createFakeClock() });
```

It ships in three shapes: `memoryCache()` (a module, for `cache({ adapter })`),
`memoryCacheProvider()` (a provider, for `overridden`) and
`memoryCacheBackend()` (the service, for a spec that wants no graph).

Nothing is serialised: the value goes in and comes back as the same reference.
That is a real difference from Redis, and it is the honest one — a fake that
deep-cloned would hide a mutation bug your deployment will have.

**No eviction and no maximum size.** A process caching unbounded keys grows
unbounded; the upgrade path is Redis, which is what a deployment with that
problem should be running.

### `redisCache()`

One connection, opened with the scope and closed with it — the client rides
the graph as a private port, so the scope closing is what closes the socket, on
every path the kernel has.

| Variable    | Required | Default | What it is                                                             |
| ----------- | -------- | ------- | ---------------------------------------------------------------------- |
| `REDIS_URL` | yes      | none    | the connection URL, read through `Config` and validated at graph build |

No default is deliberate: a cache quietly pointed at `localhost` in a
deployment that meant to set this would look like it was working. An unset or
blank variable is a `ConfigInvalid` naming it — exit `78` under `runMain`,
before a single read is served.

`redis` is an **optional** peer dependency, reached only through the
`@btravstack/cache/redis` subpath, so a consumer composing the memory adapter
never installs it.

## The two compositions

### `cache({ adapter })`

The adapter's module, plus `Cache` provided from its backend. No
observability, none installed, nothing to configure:

```ts
export const Plain = Module("PlainCacheApp")({
  imports: [cache({ adapter: memoryCache() })],
  exports: [Cache],
});
```

### `instrumentedCache({ adapter })`

The same graph, with every call spanned, counted and — when it fails — logged.

| Signal   | Name                                       | Attributes                                                |
| -------- | ------------------------------------------ | --------------------------------------------------------- |
| span     | `cache.get` / `cache.set` / `cache.delete` | `btravstack.cache.key`; error status on a failure         |
| counter  | `btravstack.cache.operations`              | `{ operation, outcome }` — `hit`, `miss`, `ok` or `error` |
| log line | `"the cache could not answer"`, at `error` | `{ operation, key }`, with the failure as the cause       |

`outcome` is the reason the counter exists: a hit rate is the number anyone
actually asks a cache for, and it is not derivable from a call count.

**Keys ride spans and log lines; values never do.** A cached value is
application data this package cannot read.

The wrapper is transparent to the `Result` — whatever the backend answers is
what the caller receives, the kernel's own `RunUnit` rule one layer down — and
a **defect** ends its span and counts as an error too.

It declares `needs: [Logger, Meter, Tracer]`, so a root that composes it
without `observability()` and `otel()` fails di's `UNSATISFIED DEPENDENCIES`
gate, naming all three:

```ts
export const Instrumented = Module("InstrumentedCacheApp")({
  imports: [
    instrumentedCache({ adapter: redisCache() }),
    observability(),
    otel(),
  ],
  exports: [Cache, Logger],
});
```

`@btravstack/observability` and `@opentelemetry/api` are **optional** peers,
reached only through the `@btravstack/cache/instrumented` subpath.

## What it deliberately does not do

- **No `getOrSet`.** Stampede semantics — lock, early recompute, serve-stale —
  differ per application, and the read-through above is clearer than a
  combinator with a policy hidden in it.
- **No invalidation strategy, no tags, no `clear()`.** Keys are yours; a
  package that cannot compose them cannot invalidate by pattern either.
- **No multi-get, no counters, no lists.** One value at a time, over the three
  operations every backend has.
