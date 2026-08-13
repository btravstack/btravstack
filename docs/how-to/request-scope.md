---
title: Open a per-request scope
description: Layer a short-lived scope — a transaction, a request id — over a long-lived application context with Module.forkScope, releasing per-request resources without touching the parent's.
---

# Open a per-request scope

**Goal:** an application-lifetime pool, plus a transaction that lives exactly
as long as one request — acquired from the pool the parent already built,
released when the request settles, never outliving it, never taking the pool
down with it.

The compiled, spec-covered version of this page is the
[request-scope example](/examples/request-scope).

## The two lifetimes, as two modules

The application module owns the pool:

```ts
const AppModule = Module("App")({
  provides: [
    Provider(ConnectionPool)({
      acquire: () => openPool(),
      release: (pool) => pool.close(),
    }),
  ],
  exports: [ConnectionPool],
});
```

The request module owns the transaction — and depends on `ConnectionPool`
**without providing it**:

```ts
const RequestModule = Module("Request")({
  provides: [
    Provider(Transaction)([ConnectionPool], {
      acquire: (pool) => beginTransaction(pool),
      release: (txn) => txn.rollbackIfOpen(),
    }),
  ],
  exports: [Transaction],
});
```

On its own, `RequestModule` has an unmet need: nothing in it supplies
`ConnectionPool`. That is not a bug — it is the declaration that this module
expects to be forked over a parent that already has one.

## Fork per request

`Module.scoped` holds the application scope open for as long as the server
runs; inside it, `Module.forkScope` opens one short-lived scope per request
over the already-built parent `Context`:

```ts
await Module.scoped(AppModule, (appCtx) =>
  serve((request) =>
    Module.forkScope(appCtx, RequestModule, (ctx) =>
      handle(request, ctx.get(Transaction)),
    ),
  ),
);
```

`forkScope`'s callback sees a `Context` carrying **both** channels — the
parent's exports and the request module's — so `ctx.get(ConnectionPool)` and
`ctx.get(Transaction)` both compile inside it.

## What the fork guarantees

- **The parent satisfies the fork's needs.** The unmet `ConnectionPool` above
  is subtracted by the parent context's channel; only a need that _neither_
  the request module _nor_ the parent satisfies is a compile error
  ("UNSATISFIED DEPENDENCIES", naming exactly what is missing).
- **Closing the fork releases only what the fork acquired.** The parent's
  services were never constructed by this call, so none of the parent's
  finalisers are registered on the fork's scope. The transaction is released
  when the request settles; the pool stays up for the next request, and for a
  second, concurrent fork.
- **Forks release before the parent.** The pool's own `release` runs only
  when the enclosing `Module.scoped` closes, after your server loop returns —
  by which point every request scope has already settled. The
  [example's spec](/examples/request-scope) asserts that exact order.

## Per-request values that are not resources

The forked module is an ordinary module — a request id or a deadline goes in
as a plain provider, no teardown involved:

```ts
const makeRequestModule = (requestId: string) =>
  Module("Request")({
    provides: [
      Provider(RequestId)({ value: requestId }),
      Provider(Transaction)([ConnectionPool], {
        acquire: (pool) => beginTransaction(pool),
        release: (txn) => txn.rollbackIfOpen(),
      }),
    ],
    exports: [RequestId, Transaction],
  });
```

Building the module fresh per request is cheap — modules are declarations, not
containers; construction happens inside the fork.

## Related

- [Manage a resource's lifetime](/how-to/manage-a-resource) — the guarantees
  each individual scope makes.
- [Entry points](/reference/entry-points) — `Module.forkScope`'s exact
  signature and gate.
- [Request scope, the example](/examples/request-scope) — release order proven
  in a spec.
