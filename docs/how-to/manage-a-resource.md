---
title: Manage a resource's lifetime
description: Acquire a connection once, release it on every path out, and run start/stop hooks at the right moments — with the compiler refusing any graph that could leak.
---

# Manage a resource's lifetime

**Goal:** a service that must be torn down — a connection pool, a file handle,
a subscription — acquired once, released exactly once, on every path out of the
program.

## Declare the resourceful provider

`acquire` and `release` come as a pair — there is no `release` with nothing to
release, nor an `acquire` never torn down:

```ts
const Persistence = Module("Persistence")({
  imports: [Config],
  provides: [
    Provider(Database)([AppConfig], {
      acquire: (config) => openPool(config.dbUrl), // Result | AsyncResult — may fail
      release: (pool) => pool.close(), // void | Promise<void> — may be async
    }),
  ],
  exports: [Database],
});
```

`acquire` is `make`'s fallible-construction twin: it returns a `Result` (or
`AsyncResult`), and a failed acquisition surfaces through the module's error
channel like any other construction failure.

Choosing this arm puts the phantom `Scope` requirement into the provider's
`Needs`. That is the whole mechanism: `Needs` propagates through every module
that imports this one, and only an entry point that actually opens a scope can
discharge it.

## Build through `Module.scoped`

```ts
const result = await Module.scoped(App, (ctx) => runServer(ctx));
```

`Module.scoped` opens a scope, builds the graph, runs your callback, and
closes the scope before its own result resolves. The close runs on **every**
path:

- your callback succeeded — released after it settles;
- your callback failed — released, and the failure passed through untouched;
- construction itself failed halfway — everything acquired **before** the
  failure is released, in reverse order.

`Module.build` — no scope, no teardown — refuses the graph at compile time
("UNSATISFIED DEPENDENCIES", with `Scope` named as the missing piece).

## Release order and failing finalisers

Finalisers run **LIFO** — reverse acquisition order — so a resource is always
released before whatever it was built from: the transaction before the
connection, the connection before the pool.

A finaliser that itself fails is **reported and swallowed**, never rethrown:
shutdown is not abandoned halfway, and a failed close never masks the failure
that triggered the unwind. Route the report where you want it with
`ScopedOptions`:

```ts
await Module.scoped(App, use, {
  onTeardownError: (portId, cause) =>
    logger.error({ portId, cause }, "teardown failed"),
});
```

The default reporter writes to `console.error`, tagged with the port id.

## `onStart` and `onStop`

Every arm of the construction family — not just `acquire`/`release` — accepts
optional lifecycle hooks in the same options literal:

```ts
Provider(Cache)([Config], {
  make: (config) => connectCache(config),
  onStart: (cache) => cache.warm(), // after the WHOLE graph is built
  onStop: (cache) => cache.flush(), // during teardown, LIFO with releases
});
```

- `onStart` fires only once the **entire** graph has finished constructing —
  never while some other provider is still mid-construction — in declaration
  order.
- `onStop` is teardown, so declaring one puts `Scope` in `Needs` exactly as
  `release` does: only a scope can run it, and the compiler routes the module
  to `Module.scoped` accordingly.

Use `release` for undoing an acquisition; use `onStop` for shutdown work on a
service you did not acquire (flushing a cache built with `make`, stopping a
consumer built with `class`).

## Verify the ordering, if you need to see it

The [request-scope example](/examples/request-scope) threads a `onEvent`
callback through its providers and asserts the exact sequence —
`pool-acquired → txn-acquired → txn-released → pool-released` — in its spec,
so the guarantee above is proven in CI, not just stated here.

## Related

- [Open a per-request scope](/how-to/request-scope) — short-lived resources
  over a long-lived parent.
- [Scopes and resource safety](/explanation/scopes-and-resources) — why `Scope`
  is a phantom port, and what that buys.
- [Providers](/reference/providers) — the full construction family.
