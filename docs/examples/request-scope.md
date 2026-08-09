---
title: Request scope
description: A compiled lifetime-management example — a pool acquired once under Module.scoped, a transaction per request via Module.forkScope, and the release order proven in a spec.
---

# Request scope

**Source:**
[`examples/request-scope`](https://github.com/btravstack/di/tree/main/examples/request-scope)

Lifetime management, compiled: an application-lifetime connection pool and a
per-request transaction, the pattern the
[per-request scope guide](/how-to/request-scope) teaches — with the guarantees
asserted as an event sequence rather than taken on faith.

## The two modules

The application module owns the pool; the request module owns the transaction
and depends on `ConnectionPool` **without providing it** — the declaration
that it expects to be forked over a parent that already has one:

```ts
export const makeAppModule = (onEvent: (event: LifecycleEvent) => void) =>
  Module("App")({
    provides: [
      Provider(ConnectionPool)({
        acquire: () => {
          onEvent("pool-acquired");
          return openPool();
        },
        release: () => void onEvent("pool-released"),
      }),
    ],
    exports: [ConnectionPool],
  });

export const makeRequestModule = (onEvent: (event: LifecycleEvent) => void) =>
  Module("Request")({
    provides: [
      Provider(Transaction)([ConnectionPool], {
        acquire: (pool) => {
          onEvent("txn-acquired");
          return beginTransaction(pool);
        },
        release: () => void onEvent("txn-released"),
      }),
    ],
    exports: [Transaction],
  });
```

One request is one fork:

```ts
export const handleRequest = <A, E>(appCtx, onEvent, work) =>
  Module.forkScope(appCtx, makeRequestModule(onEvent), (ctx) =>
    work(ctx.get(Transaction)),
  );
```

Threading lifecycle events through an `onEvent` callback — rather than
hard-coding `console.log` — is what lets the spec observe ordering without
reaching into anything private; a real caller would wire it to its logger.

## What the spec proves

`src/index.spec.ts` runs two requests inside one `Module.scoped` and asserts
on the recorded event stream:

- **Each fork releases before the next request begins, and never the pool.**
  After every `handleRequest` settles, the latest event is `txn-released` and
  `pool-released` has not occurred.
- **The full ordering, exactly.** Once the outer scope closes, the stream
  equals: pool acquired, first transaction acquired and released, second
  transaction acquired and released, pool released — `pool-released` last,
  [LIFO to the end](/explanation/scopes-and-resources).
- **Both forks drew on the same pool.** The transaction labels embed the pool
  id, and both requests' labels share it — the parent was seeded into each
  fork, not rebuilt.

Everything this example demonstrates is observable at runtime, so it needs no
type-level test of its own; the compile-time side of forking — the parent's
channel satisfying the request module's unmet need, anything neither supplies
still gating — is pinned in the library's own `fork.test-d.ts`.

## Run it

```sh
pnpm --filter @btravstack/di-example-request-scope test
```
