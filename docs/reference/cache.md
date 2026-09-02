---
title: "@btravstack/cache"
description: The complete surface of @btravstack/cache — the Cache and CacheBackend ports, CacheUnavailable, the memory and Redis adapters, cache(), the Observers seam it reports through, and REDIS_URL.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { Cache, CacheBackend, cache, memoryCache, memoryCacheProvider, type CacheService } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";
import { Logger } from "@btravstack/core";
import { observability } from "@btravstack/observability";
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
> and the composition that turns one into the
> other.

## The port

```ts
class Customers extends Port("ReferenceCustomers")<{
  readonly find: (id: string) => AsyncResult<CustomerView, never>;
  readonly forget: (id: string) => AsyncResult<void, never>;
}> {}

export const customersProvider = Provider(Customers)({
  inject: { cache: Cache },
  sync: ({ cache }) => ({
    find: (id) =>
      cache.getOrSet(`customers:${id}`, () => findCustomer(id), {
        ttlMs: 60_000,
      }),
    forget: (id) =>
      cache
        .delete(`customers:${id}`)
        .recoverErrCases((m) =>
          m.with(P.tag("CacheUnavailable"), () => undefined),
        ),
  }),
});
```

| Method                              | Answers                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `get(key)`                          | `AsyncResult<CacheHit \| undefined, CacheUnavailable>` |
| `set(key, value, { ttlMs? })`       | `AsyncResult<void, CacheUnavailable>`                  |
| `delete(key)`                       | `AsyncResult<void, CacheUnavailable>`                  |
| `getOrSet(key, loader, { ttlMs? })` | `AsyncResult<T, E>` — the loader's own channels        |

`ttlMs` is **optional, and omitting it means no expiry**: the entry stays
until something deletes it, the memory adapter's process ends, or Redis evicts
it under its own policy. There is no default TTL — a cache that quietly forgot
entries after some interval nobody chose would be the worst of both.

Four things the signatures decide:

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

## `getOrSet`, the one place the policy is decided for you

`getOrSet(key, loader, { ttlMs })` is the read-through above, once, in the
port — and it is the exception to everything the previous section said,
because the read-through is the one shape where the answer is not in doubt:

- **An unavailable cache is a miss**, so your loader runs and your caller gets
  its answer. A cache outage that turned into a 500 would be a cache making
  your application less available than not having one.
- **A failed write is not your error**, so what comes back is the value the
  loader produced. Storing it was best effort by definition.

That is why `CacheUnavailable` is absent from its error channel: what is left
is the loader's own `E`, so a triage downstream sees only what its domain can
actually produce. A hit comes back as `T` by cast — the same claim `viewOf`
makes above, made once, inside the port.

It is **derived, not implemented**: `cache()` builds it over `get` and `set`,
so an adapter still writes three methods and the two calls it makes are the
observed ones. There is no stampede protection — a hundred concurrent misses
run a hundred loaders — and adding one is a named option the day an
application needs it, not a default that changes under everybody.

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
provider per port per graph, so an observing composition cannot be a layer
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

## `cache({ adapter })`

One function, and the adapter it composes is the only decision at it.

**Observation is a set port, not a flag.** Every call is handed to whatever
contributed to `Observers`, and this module contributes a no-op member of its
own — so a graph composing no observability owes nothing, installs nothing and
an operation costs one inert call per module that reads the port. Composing
[`observability()`](/reference/observability) writes the failures as lines;
composing `otel()` beside it opens the spans and mints the instruments. Neither
changes a line of this composition.

```ts
export const Plain = Module("PlainCacheApp")({
  imports: [cache({ adapter: memoryCache() })],
  exports: [Cache],
});
```

### What the observers make of it

With `observability()` and `otel()` composed, every call is spanned, counted
and — when it fails — logged.

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
  imports: [cache({ adapter: redisCache() }), observability(), otel()],
  exports: [Cache, Logger],
});
```

**Why one boolean is enough, and what it cost to get there.** `Logger`,
`Tracer` and `Meter` are [the kernel's ports](/reference/core/observability),
so this package names them without depending on any implementation — no
subpath, no optional peer, nothing installed when the flag is `false`. That
is the whole reason those contracts were moved into `@btravstack/core`: the
alternative was a second exported function behind a subpath, or a call that
made every root pass the three ports in by hand.

**Why it defaults on.** Telemetry that is missing gets discovered during an
incident, not before one, so the quiet arm is the wrong default. And the cost
of the loud one is stated rather than hidden: instrumenting puts the three
ports in the module's `Needs`, so a root that has not composed
`observability()` and `otel()` gets a compile error naming all three. `false`
disabling a default-`true` boolean is the shape
[`StartOptions`](/reference/core/start) already uses for `signals` and
`probes`, which is also why the option keeps a positive name — `noInstrument:
false` would be a double negative.

**Why not detect the ports instead**, and instrument when a graph happens to
provide them? It would need an optional-provider notion in the container, and
it would cost the property that makes the flag worth having: the type would
stop telling the truth. Composing without `otel()` would silently produce no
spans instead of a compile error, and adding `otel()` for an unrelated reason
would quietly change this module's behaviour.

## What it deliberately does not do

- **No `getOrSet`.** Stampede semantics — lock, early recompute, serve-stale —
  differ per application, and the read-through above is clearer than a
  combinator with a policy hidden in it.
- **No invalidation strategy, no tags, no `clear()`.** Keys are yours; a
  package that cannot compose them cannot invalidate by pattern either.
- **No multi-get, no counters, no lists.** One value at a time, over the three
  operations every backend has.
- **No `keyPrefix` option.** Two applications sharing one Redis separate
  through the URL — `redis://host:6379/3` and `…/4` are different keyspaces,
  and that is a deployment change with no code. A prefix would be the weaker
  of two ways to do one thing (it does not isolate `FLUSHDB`, `SCAN` or
  `DBSIZE`). Redis Cluster is the exception — it has only database 0 — and is
  when the option would earn its place.
