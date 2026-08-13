---
title: Plugin registry
description: A compiled multi-binding example — a Port.many health-check registry fed by two independent modules, collected whole by the composition root, failures folded into the report.
---

# Plugin registry

**Source:**
[`examples/plugin-registry`](https://github.com/btravstack/di/tree/main/examples/plugin-registry)

Multi-binding, compiled: a health-check registry as a
[set port](/reference/ports#port-many-id-member), two plugin modules that
contribute to it without knowing of each other, and a composition root that
collects and runs the lot — the
[plugin-registry guide](/how-to/plugin-registry)'s material as real code.

## The set port and its contributors

```ts
export class HealthCheck extends Port.many("HealthCheck")<{
  readonly name: string;
  readonly run: () => AsyncResult<"healthy", HealthCheckFailed>;
}> {}
```

Each plugin module provides its own service and contributes one member —
`DatabaseModule` a check over `Database`, `CacheModule` one over `Cache`:

```ts
export const DatabaseModule = Module("Database")({
  provides: [
    Provider(Database)({ value: { ping: () => OkAsync("healthy") } }),
    Provider.member(HealthCheck)([Database], {
      sync: (db) => ({ name: "database", run: db.ping }),
    }),
  ],
  exports: [Database, HealthCheck],
});
```

The cache's `ping` is wired to fail — deliberately, because a registry that
only demonstrates the happy path would miss the design question below.

The composition root imports both and re-exports them whole:

```ts
export const AppModule = Module("App")({
  imports: [DatabaseModule, CacheModule],
  exports: [DatabaseModule, CacheModule],
});
```

## The design question the example answers

What does "run them all" mean when one fails? That is the **composition
root's** decision, not the library's — `ctx.get(HealthCheck)` hands back
`readonly Member[]` and steps aside. This root folds: every check runs, and a
failing one becomes an `unhealthy` row in the report rather than stopping the
rest, with the `errCases`/`defect` split
[kept distinct](/explanation/failures-vs-defects) to the end — an expected
`HealthCheckFailed` carries its reason; an unexpected bug reads
`"unexpected failure"`.

## What the spec proves

`src/index.spec.ts` builds `AppModule` and asserts:

- **Both contributions land on one port.** `ctx.get(HealthCheck)` yields the
  cache and database members — contributed by modules that never import each
  other.
- **The fold works.** The report holds `database: healthy` and
  `cache: unhealthy` with the failure's reason — collected, not aborted.
- **Contribution is open.** A third module adding a `queue` check joins the
  registry without either existing module changing — the list grows to
  `["cache", "database", "queue"]`.

## Run it

```sh
pnpm --filter @btravstack/di-example-plugin-registry test
```
