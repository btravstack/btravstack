---
title: Cache a read
description: "Compose the cache starter, read through it with getOrSet, compose the key yourself — tenant included — and know what happens when Redis is down."
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Cache, cache, memoryCache } from "@btravstack/cache";
import { createFakeClock } from "@btravstack/testing";
import { redisCache } from "@btravstack/cache/redis";
import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";

type Customer = { readonly id: string; readonly name: string };
class CustomerNotFound extends TaggedError("CustomerNotFound")<{ readonly id: string }> {}
class FindCustomer extends Port("FindCustomer")<{
  readonly execute: (tenantId: string, id: string) => AsyncResult<Customer, CustomerNotFound>;
}> {}
declare const CustomerApplicationModule: Module<FindCustomer, never, never>;
-->

# Cache a read

> **How-to.** Put a cache in front of a read without spreading cache-handling
> through the code that does the reading. For the port's full surface, see
> [`@btravstack/cache`](/reference/cache).

## 1. Compose the starter

One decision — which adapter:

```ts
export const CachedCustomers = Module("CachedCustomers")({
  imports: [
    CustomerApplicationModule,
    cache({ adapter: redisCache() }),
    // Composing these is what turns the counters and the failure lines on;
    // drop them and the calls are still made, to nobody.
    observability(),
    otel(),
  ],
  exports: [Cache, Logger],
});
```

`redisCache()` binds `REDIS_URL` through `Config` and holds one connection as a
resource of the graph. `memoryCache()` is the same port over a `Map` — for a
test, or for a process that genuinely wants a per-process cache.

## 2. Read through it

```ts
const VIEW_TTL_MS = 60_000;

const keyFor = (tenantId: string, id: string) => `customers:${tenantId}:${id}`;

export const cachedCustomers = Provider(
  Port("CachedCustomerReader")<{
    readonly find: (tenantId: string, id: string) => AsyncResult<Customer, CustomerNotFound>;
  }>,
)({
  inject: { find: FindCustomer, cache: Cache },
  sync: ({ find, cache }) => ({
    find: (tenantId, id) =>
      cache.getOrSet(keyFor(tenantId, id), () => find.execute(tenantId, id), {
        ttlMs: VIEW_TTL_MS,
      }),
  }),
});
```

That is the whole recipe. `getOrSet` answers from the cache when the key is
there and runs the loader when it is not, and **the two degradations are the
port's, decided once**:

- an **unavailable cache is a miss**, so the loader runs and your caller gets
  its answer — a cache outage that turned into a 500 would be a cache making
  the application less available than not having one;
- a **failed write is not your error**, so what comes back is the value the
  loader produced.

Which is why `CacheUnavailable` is not in the result type: what is left is the
loader's own error, `CustomerNotFound`, exactly as if no cache were there.

## 3. Compose the key yourself, tenant included

`Cache` takes plain string keys and composes none of them. There is no
namespace parameter and no tenant slot — the framework has no concept of a
tenant anywhere, and a cache is an application service. So the tenant goes in
the key **by hand**, and getting it wrong serves one tenant's customer to
another:

```ts
const keyForCustomer = (tenantId: string, id: string) =>
  `customers:${tenantId}:${id}`;
```

The same discipline `find.execute(tenantId, id)` states in its type, spelled
where the type cannot.

**Make the join unambiguous.** With a bare separator, `("a:b", "c")` and
`("a", "b:c")` produce the same key — one tenant reading another's entry, which
is the exact failure the tenant-in-the-key is there to prevent. Either use a
separator the ids cannot contain (a UUID tenant and a UUID id cannot contain
`:`, which is why the example above is safe), or encode the parts:

```ts
const keyForEncoded = (tenantId: string, id: string) =>
  `customers:${encodeURIComponent(tenantId)}:${encodeURIComponent(id)}`;
```

## What `ttlMs` means, and what it does not

`ttlMs` is optional and **omitting it means no expiry**: the entry stays until
something deletes it, the process ends (memory) or Redis evicts it under its
own policy. There is no default TTL, because a cache that forgot entries after
an interval nobody chose would be the worst of both.

There is also **no stampede protection**: a hundred concurrent misses run a
hundred loaders. Locking, early recompute and serve-stale each need state this
port does not have, and each is a different application's answer.

## Invalidating

Write through the same key, or delete it:

```ts
export const renameCustomer = Provider(
  Port("RenameCustomer")<{
    readonly rename: (tenantId: string, id: string, name: string) => AsyncResult<void, never>;
  }>,
)({
  inject: { cache: Cache },
  sync: ({ cache }) => ({
    rename: (tenantId, id, _name) =>
      cache
        .delete(keyFor(tenantId, id))
        // Here the recovery IS yours: a delete that failed leaves a stale
        // entry, and whether that is worth failing the write over is the
        // application's call. This one says no, and the ttl bounds it.
        .recoverErrCases((matcher) => matcher.with({ _tag: "CacheUnavailable" }, () => undefined)),
  }),
});
```

`delete` is idempotent — deleting a key nobody set is `Ok` — so an
invalidation does not need to know whether the entry was there.

## In a test

Substitute the adapter, not the cache:

```ts
export const TestCachedCustomers = Module("TestCachedCustomers")({
  imports: [CustomerApplicationModule, cache({ adapter: memoryCache() })],
  exports: [Cache],
});
```

The memory adapter measures its TTL against the kernel's `Clock`, so a fake one
lets a test advance past an expiry without waiting for it:

```ts
const clock = createFakeClock();

export const ExpiringCache = Module("ExpiringCache")({
  imports: [cache({ adapter: memoryCache({ clock }) })],
  exports: [Cache],
});
// … then `await clock.advance(60_000)` in the test, and the next `get` misses.
```

## Where to go next

- The port's surface, and the two-port split behind it:
  [`@btravstack/cache`](/reference/cache).
- What the read costs when it misses:
  [Talk to a database](/how-to/talk-to-the-database).
- Swapping an adapter under the real root:
  [Swap an adapter for tests](/how-to/swap-an-adapter).
