# @btravstack/cache

> The cache port for [`@btravstack/core`](../core): one `Cache` an application
> depends on, an in-memory and a Redis adapter behind it, and an opt-in
> composition that spans, counts and logs every call.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/cache)** ·
[API Reference](https://btravstack.github.io/btravstack/api/cache/)

```sh
pnpm add @btravstack/cache @btravstack/core @btravstack/config @btravstack/di unthrown
```

Four peer dependencies, plus `redis` — optional, and needed only if you
compose the Redis adapter. Instrumentation needs no peer of its own: the
`Logger`, `Tracer` and `Meter` it depends on are
[the kernel's ports](https://btravstack.github.io/btravstack/reference/core/observability),
and `@btravstack/observability` is what an application composes to satisfy
them. Node `>=22`.

## A worked example

<!-- doctest: prelude
import { Module } from "@btravstack/di";
import { FindCustomer } from "@btravstack/example-order-application";
import type { CustomerNotFound } from "@btravstack/example-order-domain";
import { TenantId } from "@btravstack/example-order-domain";
import { OkAsync, P } from "unthrown";
import { Logger } from "@btravstack/core";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { CustomerApplicationModule } from "@btravstack/example-order-application";
import { CustomerPersistenceModule } from "@btravstack/example-order-infrastructure";

// The application's own view type and the conversion into it — its layer's
// business, not the cache's, so it stands in here rather than in the sample.
type CustomerView = { readonly id: string; readonly name: string };
declare const view: (customer: { readonly id: string; readonly name: string }) => CustomerView;
-->

A read-through, which is one call — the degradation policy lives in the port:

```ts
import { Cache } from "@btravstack/cache";
import { Port, Provider } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

class Customers extends Port("ReadmeCustomers")<{
  readonly find: (
    tenantId: string,
    id: string,
  ) => AsyncResult<CustomerView, CustomerNotFound>;
}> {}

const customers = Provider(Customers)({
  inject: { find: FindCustomer, cache: Cache },
  sync: ({ find, cache }) => ({
    find: (tenantId, id) =>
      cache.getOrSet<CustomerView, CustomerNotFound>(
        // The key carries the tenant, because the port does not: `Cache` takes
        // plain strings, and composing them is the application's job.
        `customers:${tenantId}:${id}`,
        () => find.execute(TenantId(tenantId), id).map(view),
        { ttlMs: 60_000 },
      ),
  }),
});
```

And the composition — the adapter is the only decision at it:

```ts
import { cache } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";

export const CustomersApp = Module("CustomersApp")({
  imports: [
    CustomerApplicationModule,
    CustomerPersistenceModule,
    // Every call is reported through `Observers`. Drop the two modules
    // below and this composition is unchanged — it just reports to nobody.
    cache({ adapter: redisCache() }),
    observability(),
    otel(),
  ],
  provides: [customers],
  exports: [Customers, Logger],
});
```

## Options

| Option      | Where                               | What it is                                                                        |
| ----------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `adapter`   | `cache({ adapter })`                | the adapter module providing `CacheBackend` — required                            |
| `clock`     | `memoryCache`                       | what a ttl is measured against (default: the kernel's `systemClock`)              |
| `REDIS_URL` | environment, read by `redisCache()` | the connection URL — required, validated at graph build                           |
| `ttlMs`     | `cache.set` / `cache.getOrSet`      | per-entry expiry (default: none — the entry stays until it is deleted or evicted) |

The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/cache),
which is this list's one detailed home.

## What it decides, and what it does not

**It decides** that a miss is `Ok(undefined)` and not an error, that a failing
backend is a modeled `CacheUnavailable` rather than a swallowed one, that
values are `unknown` encoded by the adapter, and that keys are plain strings
the caller composes.

**It decides one thing for you**: that every call is reported through
`Observers`. Nothing is required to receive those reports — a graph composing
no observability compiles, starts and pays an inert call — so the decision
costs you a port list only if you want the spans and the instruments, and then
you compose `observability()` and `otel()` and change nothing here.

**It does not decide** whether an unreachable cache degrades a `get` — recover
`CacheUnavailable` where you call it — nor what your keys look like, nor when
to invalidate them. The one place it does decide is `getOrSet`, where an
unreachable cache runs your loader and a failed write is not your error. There
is no stampede protection, no eviction on the memory adapter, and no namespace
parameter; the reasons are in [`CLAUDE.md`](./CLAUDE.md).
