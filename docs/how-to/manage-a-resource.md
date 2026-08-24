---
title: Manage a resource's lifetime
description: Acquire a connection once, release it on every path out, and run start/stop hooks at the right moments — with the compiler refusing any graph that could leak.
---

<!-- doctest: prelude
import { Module, Port, Provider, type Context, type ScopedOptions, type Scope, type ServiceOf } from "@btravstack/di";
import { Env } from "@btravstack/config";
import type { AsyncResult } from "unthrown";
class AppConfig extends Port("AppConfig")<{ readonly dbUrl: string }> {}
type PoolClient = { readonly close: () => void };
class Database extends Port("Database")<PoolClient> {}
declare const Config: Module<AppConfig, never, Env>;
declare const openPool: (url: string) => AsyncResult<PoolClient, never>;
type CacheClient = { readonly warm: () => void; readonly flush: () => void };
class Cache extends Port("Cache")<CacheClient> {}
declare const connectCache: (
  config: ServiceOf<AppConfig>,
) => AsyncResult<CacheClient, never>;
declare const App: Module<Database, never, Scope>;
declare const runServer: (ctx: Context<Database>) => AsyncResult<void, never>;
declare const use: (ctx: Context<Database>) => AsyncResult<void, never>;
declare const logger: {
  readonly error: (data: unknown, message: string) => void;
};
-->

# Manage a resource's lifetime

> **How-to.** Own a service that must be torn down — a pool, a file handle, a
> subscription — and have it released exactly once, on every path out. For
> _why_ `Scope` is a phantom port and what the scope guarantees, see
> [Scopes and resource safety](/explanation/scopes-and-resources).

**Goal:** a resource acquired once, released exactly once, and a graph that
cannot compile if nothing would release it.

## Declare the resourceful provider

`acquire` and `release` come as a pair — there is no `release` with nothing to
release, nor an `acquire` never torn down:

```ts
const Persistence = Module("Persistence")({
  imports: [Config],
  provides: [
    Provider(Database)(
      { config: AppConfig },
      {
        acquire: ({ config }) => openPool(config.dbUrl), // Result | AsyncResult — may fail
        release: (pool) => pool.close(), // void | Promise<void>
      },
    ),
  ],
  exports: [Database],
});
```

`acquire` is `make`'s fallible twin: it returns a `Result` or an
`AsyncResult`, and a failed acquisition surfaces through the module's error
channel like any other construction failure.

Choosing this arm puts the phantom `Scope` into the provider's `Needs`. That
is the whole mechanism: `Needs` propagates through every module that imports
this one, and only an entry point that actually opens a scope can discharge
it.

## Build through `Module.scoped`

```ts
const result = await Module.scoped(App, (ctx) => runServer(ctx));
```

`Module.scoped` opens a scope, builds the graph, runs your callback and closes
the scope **before its own result settles**. The close runs on every path:

- your callback succeeded — released after it settles;
- your callback failed — released, and the failure passed through untouched;
- construction itself failed halfway — everything acquired **before** the
  failure is released, in reverse order.

`Module.build` — no scope, no teardown — refuses the graph at compile time:
`Expected 3 arguments, but got 1`. That arity line is the whole message; the
`UNSATISFIED DEPENDENCIES` label and `Scope` as the missing piece live in the
rest parameter's type. To get them printed, spell the phantom arguments out by
hand — a value the tuple cannot accept names each slot in turn, ending on
`Argument of type 'number' is not assignable to parameter of type 'Scope'`.

## Under `start`, the process is the scope

An application booted by the kernel never calls `Module.scoped` itself.
[`start`](/reference/core/start) accepts a `Module<X, E, Scope | Env>` — the
resourceful module is welcome as it is — wraps it and hands it to
`Module.scoped`, so the **application scope spans the whole process**: opened
during `building`, closed on every exit path (`stop()`, a signal, an uncaught
exception, a runtime that stopped on its own). What a finaliser reports on the
way down lands in `ExitReport.teardownErrors` and a `teardownError` event, and
`runMain` exits `2` over a non-empty list rather than `0`. A resource that
must live per _unit_ rather than per process goes in the `unit` module
instead — the kernel forks a scope around every unit for you (see
[Open a per-request scope](/how-to/open-a-per-request-scope)).

## Release order and failing finalisers

Finalisers run **LIFO** — reverse acquisition order — so a resource is always
released before whatever it was built from: the transaction before the
connection, the connection before the pool. Teardown is sequential for the
same reason.

A finaliser that fails is **reported and swallowed**, never rethrown: shutdown
is not abandoned halfway, and a failed close never masks the failure that
triggered the unwind. Route the report with `ScopedOptions`:

```ts
const options: ScopedOptions = {
  onTeardownError: (portId, cause) =>
    logger.error({ portId, cause }, "teardown failed"),
};
await Module.scoped(App, use, options);
```

The default reporter writes to `console.error`, tagged with the port id.

## `onStart` and `onStop`

Every arm — not only `acquire`/`release` — accepts optional lifecycle hooks in
the same options literal:

```ts
Provider(Cache)(
  { config: AppConfig },
  {
    make: ({ config }) => connectCache(config),
    onStart: (cache) => cache.warm(), // after the WHOLE graph is built
    onStop: (cache) => cache.flush(), // during teardown, LIFO with releases
  },
);
```

- `onStart` fires only once the **entire** graph has finished constructing —
  never while another provider is mid-construction — in declaration order. A
  hook that throws or rejects is a **defect**, and every hook after it is
  skipped; the finalisers already registered still run.
- `onStop` is teardown, so declaring one puts `Scope` in `Needs` exactly as
  `release` does: only a scope can run it, and the compiler routes the module
  to `Module.scoped` accordingly.

Use `release` for undoing an acquisition; use `onStop` for shutdown work on a
service you did not acquire — flushing a cache built with `make`, stopping a
consumer built with `class`.

## See also

- [Open a per-request scope](/how-to/open-a-per-request-scope) — a
  short-lived resource over a long-lived parent, forked by the kernel.
- [Scopes and resource safety](/explanation/scopes-and-resources) — the
  guarantees behind the scope, and why there is no scope object in your code.
- [Providers](/reference/di/providers) — the full construction family and
  the hooks, precisely.
- [Entry points](/reference/di/entry-points) — `Module.scoped`,
  `Module.forkScope` and `ScopedOptions`.
