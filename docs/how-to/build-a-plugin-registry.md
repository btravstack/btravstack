---
title: Build a plugin registry
description: Let independent modules contribute members to one set port with Port.many and Provider.member — health checks, event handlers, plugins — collected by the composition root.
---

<!-- doctest: prelude
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { OkAsync, P, TaggedError, allAsync, type AsyncResult } from "unthrown";
class HealthCheckFailed extends TaggedError("HealthCheckFailed")<{
  readonly reason: string;
}> {}
type Pingable = { readonly ping: () => AsyncResult<"healthy", HealthCheckFailed> };
class Database extends Port("Database")<Pingable> {}
class Cache extends Port("Cache")<Pingable> {}
declare const cacheService: Pingable;
-->

# Build a plugin registry

> **How-to.** Collect contributions from modules that do not know about each
> other into one list. For the ports and providers involved, precisely, see
> [Ports](/reference/di/ports) and [Providers](/reference/di/providers).

**Goal:** several modules, none knowing about the others, each contributing an
entry — a health check, an event handler, a plugin — to one list the
composition root collects whole.

## Declare a set port

`Port.many` fixes the **member** shape — what one contribution looks like. The
port's own service, what `Context.get` returns, is the accumulated list,
`readonly Member[]`:

```ts
class HealthCheck extends Port.many("HealthCheck")<{
  readonly name: string;
  readonly run: () => AsyncResult<"healthy", HealthCheckFailed>;
}> {}
```

## Contribute from independent modules

`Provider.member` contributes one member. Several providers targeting one set
port is the point, not a collision — the duplicate-provider defect that guards
ordinary ports does not apply here:

```ts
const DatabaseModule = Module("Database")({
  provides: [
    Provider(Database)({ value: { ping: () => OkAsync("healthy") } }),
    Provider.member(HealthCheck)(
      { db: Database },
      { sync: ({ db }) => ({ name: "database", run: db.ping }) },
    ),
  ],
  exports: [Database, HealthCheck],
});

const CacheModule = Module("Cache")({
  provides: [
    Provider(Cache)({ value: cacheService }),
    Provider.member(HealthCheck)(
      { cache: Cache },
      { sync: ({ cache }) => ({ name: "cache", run: cache.ping }) },
    ),
  ],
  exports: [Cache, HealthCheck],
});
```

Neither module imports the other, and neither knows how many other
contributors exist. `Provider.member` takes the same construction family an
ordinary provider does — `value`, `sync`, `make`, `class`, `acquire`/`release`,
plus the hooks — so a member may have dependencies, fail to construct, or own
a resource, exactly like any other service.

## Collect at the composition root

```ts
const AppModule = Module("App")({
  imports: [DatabaseModule, CacheModule],
  exports: [DatabaseModule, CacheModule], // whole-module re-export
});

const report = await Module.build(AppModule).flatMap((ctx) => {
  const checks = ctx.get(HealthCheck); // readonly Member[] — both contributions
  return runHealthChecks(checks);
});
```

`ctx.get` on a set port returns every contribution, accumulated across module
boundaries. Members land in the order construction places them — a
dependency-free member is ready before a sibling that depends on something
else — so treat the list as a set, not a sequence. A set port with no
contributors is not an error: the list is empty.

Note the whole-module re-export: `exports: [DatabaseModule, CacheModule]`
forwards everything those imports export, which is how `HealthCheck` (and
`Database`, and `Cache`) stay nameable on the built context without `App`
listing each port again.

## Run the contributions your way

What "run them all" means — fail fast, fold failures into a report, race
them — is the composition root's decision, not the library's. Folding keeps a
failing check as data rather than a reason to stop asking the others:

```ts
const runHealthChecks = (checks: ServiceOf<typeof HealthCheck>) =>
  allAsync(
    checks.map((check) =>
      check
        .run()
        .map(() => ({ name: check.name, status: "healthy" as const }))
        .recoverErrCases((m) =>
          m.with(P.tag("HealthCheckFailed"), (e) => ({
            name: check.name,
            status: "unhealthy" as const,
            reason: e.reason,
          })),
        ),
    ),
  );
```

`recoverErrCases` empties each check's error channel, so `allAsync` can only
short-circuit on a defect — a check that _threw_ rather than answered, which is
a bug worth surfacing.

## One port id, one kind

A port id must be one thing or the other everywhere: registering the same id
through `Provider(...)` in one place and `Provider.member(...)` in another is a
[wiring defect](/reference/di/wiring-defects), caught before any factory runs.
The types steer you towards `Provider.member` — on an ordinary port its member
shape is `never`, so no arm can be satisfied and the call does not compile —
and the runtime check backs that up against widened types.

::: warning
`Provider(SetPort)(…)` — the ordinary constructor on a set port — is **not**
rejected by the types: it qualifies against the whole `readonly Member[]`, and
at runtime the port is still a set port, so the array you supplied lands as
_one member_. Contribute to a set port with `Provider.member` only.
:::

## See also

- [Ports](/reference/di/ports) — `Port.many` beside ordinary `Port`.
- [Providers](/reference/di/providers) — `Provider.member` and the
  construction family.
- [Wiring defects](/reference/di/wiring-defects) — every pre-construction
  check.
