---
title: Build a plugin registry
description: Let independent modules contribute members to one set port with Port.many and Provider.member — health checks, event handlers, plugins — collected by the composition root.
---

# Build a plugin registry

**Goal:** several modules, none knowing about the others, each contributing an
entry — a health check, an event handler, a plugin — to one list the
composition root collects whole.

The compiled, spec-covered version of this page is the
[plugin-registry example](/examples/plugin-registry).

## Declare a set port

`Port.many` fixes the **member** shape — what one contribution looks like. The
port's own service, what `Context.get` actually returns, is the whole
accumulated list, `readonly Member[]`:

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
    Provider.member(HealthCheck)([Database], {
      sync: (db) => ({ name: "database", run: db.ping }),
    }),
  ],
  exports: [Database, HealthCheck],
});

const CacheModule = Module("Cache")({
  provides: [
    Provider(Cache)({ value: cacheService }),
    Provider.member(HealthCheck)([Cache], {
      sync: (cache) => ({ name: "cache", run: cache.ping }),
    }),
  ],
  exports: [Cache, HealthCheck],
});
```

Neither module imports the other, and neither knows how many other contributors
exist. `Provider.member` takes the same construction family an ordinary
provider does — `value`, `sync`, `make`, `class`, `acquire`/`release` — so a
member may have dependencies, fail to construct, or own a resource, exactly
like any other service.

## Collect at the composition root

```ts
const AppModule = Module("App")({
  imports: [DatabaseModule, CacheModule],
  exports: [DatabaseModule, CacheModule], // whole-module re-export
});

await Module.build(AppModule).flatMap((ctx) => {
  const checks = ctx.get(HealthCheck); // readonly Member[] — BOTH contributions
  return runAll(checks);
});
```

`ctx.get` on a set port returns every contribution, accumulated across module
boundaries, in a stable order (declaration order within each level of the
build). A set port with no contributors is not an error — the list is empty.

Note the whole-module re-export: `exports: [DatabaseModule, CacheModule]`
re-exports everything those imports export, which is how `HealthCheck` (and
`Database`, and `Cache`) stay nameable on the built context without `App`
listing each port again.

## Run the contributions your way

What "run them all" means — fail fast, fold failures into a report, race them —
is the composition root's decision, not the library's. The example folds:

```ts
const runHealthChecks = (checks: ServiceOf<typeof HealthCheck>) =>
  Promise.all(
    checks.map((check) =>
      check.run().match({
        ok: () => ({ name: check.name, status: "healthy" as const }),
        errCases: (m) =>
          m.with(P.tag("HealthCheckFailed"), (e) => ({
            name: check.name,
            status: "unhealthy" as const,
            reason: e.reason,
          })),
        defect: () => ({
          name: check.name,
          status: "unhealthy" as const,
          reason: "unexpected",
        }),
      }),
    ),
  );
```

A failing check is data the caller wants, not a reason to stop asking the
others.

## One port id, one kind

A port id must be one thing or the other everywhere: registering the same id
through `Provider(...)` in one place and `Provider.member(...)` in another is a
[wiring defect](/reference/wiring-defects), caught before any factory runs.
The type system already steers you right — `Provider` on a set port and
`Provider.member` on an ordinary one both fail to compile — and the runtime
check backs it up against widened types.

## Related

- [Ports](/reference/ports) — `Port.many` beside ordinary `Port`.
- [Wiring defects](/reference/wiring-defects) — every pre-construction check.
- [Plugin registry, the example](/examples/plugin-registry) — accumulation
  across modules, proven in a spec.
