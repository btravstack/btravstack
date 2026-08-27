---
title: Configure from the environment
description: Bind a typed configuration slice from environment variables with @btravstack/config, validated once as the graph is built and injected like any other service.
---

<!-- doctest: prelude
import { start } from "@btravstack/core";
import { OrderApi } from "../../module.js";
const App = OrderApi;
-->

# Configure from the environment

> **How-to.** The lesson that fronts this recipe:
> [Configure and test](/tutorial/configure-and-test).
> Turn a handful of environment variables into a typed service the
> rest of your graph depends on, and let the kernel report a bad deployment
> as exit code `78`. For the full surface, see
> [`@btravstack/config`](/reference/config); for _why_ configuration is a
> port and not a `process.env` read, see [Starters](/explanation/starters).

You want `DATABASE_URL` and `DATABASE_POOL_SIZE` read once, checked once, and
handed to the provider that opens the pool — with nothing in your application
touching `process.env`. The recipe is one provider.

## Recipe

1. Describe the slice with `Config.object({...})` — one `Config.string`,
   `Config.integer` or `Config.port` field per variable.
2. Bind it with `Config.provider("Name")(schema)`, which mints the port, or
   `Config.provider(Port)(schema)` for a port you declared.
3. Put the provider in a module and list its port in the deps of whatever
   reads it.
4. Boot under `start`/`runMain`: the kernel provides `Env`, and a bad value
   is a `ConfigInvalid` before anything serves.

```ts
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";

class Database extends Port("Database")<{ readonly query: () => string }> {}
declare const openDatabase: (config: {
  url: string;
  poolSize: number;
}) => ServiceOf<Database>;

const databaseConfig = Config.provider("DatabaseConfig")(
  Config.object({
    url: Config.string("DATABASE_URL"),
    poolSize: Config.integer("DATABASE_POOL_SIZE", {
      min: 1,
      max: 64,
      default: 8,
    }),
  }),
);

export const Persistence = Module("Persistence")({
  // Every reader of the environment says so: `start` is what provides `Env`.
  needs: [Env],
  provides: [
    databaseConfig,
    Provider(Database)(
      { config: databaseConfig.port },
      { sync: ({ config }) => openDatabase(config) },
    ),
  ],
  exports: [Database],
});
```

`Config.provider("DatabaseConfig")` mints a port whose service is the schema's
output — `{ url: string; poolSize: number }` — and hands back the provider
carrying it as `databaseConfig.port`. **That is the shape for a slice one
application owns**: nothing else ever needs to name the port, so no class line
names it twice. `examples/order-amqp-worker/src/outbox-relay.ts` uses exactly
this:

```ts
export const relayConfig = Config.provider("RelayConfig")(
  Config.object({
    pollMs: Config.integer("OUTBOX_POLL_MS", {
      min: 1,
      max: 60_000,
      default: 200,
    }),
    tenants: Config.string("OUTBOX_TENANTS"),
  }),
);
```

`tenants` has **no default**, and that is the interesting half: the relay
sweeps outside any unit, so there is no ambient record to read a tenant from,
and "whatever is in the table" is how one deployment starts broadcasting
another's facts. A required variable is what makes an operator say whose.

## A port other packages name

When the slice is public API — a starter's `HttpConfig`, which another package
imports — declare the port and pass the class. Same provider, same schema:

```ts
import { Config } from "@btravstack/config";
import { Port } from "@btravstack/di";

export class CacheConfig extends Port("CacheConfig")<{
  readonly url: string;
  readonly ttlSeconds: number;
}> {}

export const cacheConfig = Config.provider(CacheConfig)(
  Config.object({
    url: Config.string("CACHE_URL", { default: "redis://127.0.0.1:6379" }),
    ttlSeconds: Config.integer("CACHE_TTL_SECONDS", { min: 0, default: 60 }),
  }),
);
```

## What each field accepts

Every field goes through the same three-way read, pinned by the package's own
spec. **An empty or blank value is an error, never the default** — `Number("")`
is `0`, and `PORT=` would otherwise bind the ephemeral port.

| Variable is…                    | Result                                       |
| ------------------------------- | -------------------------------------------- |
| unset                           | the `default`, or `is required` without one  |
| set to `""` or whitespace       | `is set but empty`                           |
| `abc` for an integer or port    | `is not a whole number: "abc"`               |
| `3.5` for an integer or port    | `is not a whole number: "3.5"`               |
| outside `min`/`max` (inclusive) | `must be between 1 and 64, got 100`          |
| a port                          | `0..65535` — `0` is legal, an ephemeral bind |

`Config.port` has a floor of `0` deliberately: `PORT=0` is how a test asks the
OS for a free port and reads it back from `runtimeInfo()`.

## Pin a field from code

A starter's options pin a field instead of reading it — `http({ port: 0 })`
still reads `HOST`. `Config.pinned(value, field)` is that rule, per field:
explicit beats environment beats default.

```ts
export const cacheConfigWith = (options: { readonly url?: string } = {}) =>
  Config.provider(CacheConfig)(
    Config.object({
      url: Config.pinned(
        options.url,
        Config.string("CACHE_URL", { default: "redis://127.0.0.1:6379" }),
      ),
      ttlSeconds: Config.integer("CACHE_TTL_SECONDS", { min: 0, default: 60 }),
    }),
  );
```

The shipped starters expose the same knob: `HttpModule`'s `port` / `hostname`,
`TemporalModule`'s `address` / `namespace`, `AmqpModule`'s `url`. A pinned
field reads nothing from the environment; the module's `Env` need and
`ConfigInvalid` error stay in its type either way.

## Hand a test its environment

Under `start`, `Env` is provided by the kernel — `process.env` by default,
`StartOptions.env` when a test says otherwise. Nothing in the module changes:

```ts
const app = start(App, {
  env: { DATABASE_URL: "postgres://localhost/orders", DATABASE_POOL_SIZE: "4" },
  signals: false,
  probes: false,
});
// app.exited: AsyncResult<ExitReport, ConfigInvalid | RuntimeStartFailed>
```

Outside the kernel — a bare `Module.scoped` — provide `Env` yourself with
`Provider(Env)({ value: process.env })`.

## What a bad deployment looks like

`runMain` reports a `ConfigInvalid` as a `startFailed` event on stderr — one
line per variable, every fault at once — and sets exit code **`78`**
(sysexits' `EX_CONFIG`: the deployment is wrong, not the code). Booting the
module above with `DATABASE_URL` unset and `DATABASE_POOL_SIZE=100`:

```json
{"type":"building"}
{"type":"startFailed","cause":{"name":"ConfigInvalid","message":"DatabaseConfig could not be configured:\n  DATABASE_URL: is required\n  DATABASE_POOL_SIZE: must be between 1 and 64, got 100","stack":"…"}}
{"type":"stopping"}
{"type":"exited"}
```

The kernel's own `PROBE_PORT`, `PRE_DRAIN_DELAY_MS` and `DRAIN_TIMEOUT_MS` are
bound the same way, in one pass; a bad one is a `RuntimeStartFailed` for
`"kernel"` whose `cause` is the `ConfigInvalid`, and `runMain` still exits
`78`. See [runMain and exit codes](/reference/core/exit-codes).

## What the framework itself reads

Every starter binds its own configuration this way, and every one of those
variables is **pinned** by the matching option — explicit beats environment
beats default, per field — so a value that varies by deployment can move to the
deployment without a code change, and a value that is a decision stays in the
composition root.

| Variable                   | Default                 | Bound by                                                    |
| -------------------------- | ----------------------- | ----------------------------------------------------------- |
| `PROBE_PORT`               | `9000`                  | the kernel ([probes](/reference/core/probes))               |
| `PRE_DRAIN_DELAY_MS`       | `5000`                  | the kernel ([drain](/how-to/tune-the-drain-for-kubernetes)) |
| `DRAIN_TIMEOUT_MS`         | `20000`                 | the kernel                                                  |
| `PORT` / `HOST`            | `3000` / `0.0.0.0`      | [`http()`](/reference/http-server)                          |
| `HTTP_BODY_LIMIT`          | `1048576`               | `http()` — `0` is unbounded                                 |
| `HTTP_CORS_ORIGIN`         | unset (CORS off)        | `http()` — comma-separated origins, or `*`                  |
| `HTTP_COMPRESSION`         | `false`                 | `http()` — response compression                             |
| `TEMPORAL_ADDRESS`         | `127.0.0.1:7233`        | [`temporal()`](/reference/temporal-worker)                  |
| `TEMPORAL_NAMESPACE`       | `default`               | `temporal()`                                                |
| `TEMPORAL_GRACE_PERIOD_MS` | `10000`                 | `temporal()` — `shutdownGraceTime`                          |
| `TEMPORAL_FORCE_AFTER_MS`  | `15000`                 | `temporal()` — `shutdownForceTime`                          |
| `AMQP_URL`                 | `amqp://127.0.0.1:5672` | [`amqp()`](/reference/amqp-worker)                          |
| `AMQP_CONNECT_TIMEOUT_MS`  | `5000`                  | `amqp()`                                                    |
| `LOG_LEVEL`                | `info`                  | [`observability()`](/reference/observability)               |
| `DATABASE_URL`             | required                | [`prismaDatabase()`](/reference/prisma)                     |
| `REDIS_URL`                | required                | [`cache()` over Redis](/reference/cache)                    |
| `SMTP_URL`                 | required                | [`mailer()` over SMTP](/reference/mailer)                   |
| `STORAGE_S3_*`             | see the page            | [`storage()` over S3](/reference/storage)                   |

**A variable carries its starter's prefix**, so two starters in one process
cannot collide — an HTTP deployment that also publishes to AMQP and reads a
database composes three of them. `HTTP_`, `TEMPORAL_`, `AMQP_`, `STORAGE_S3_`
are the namespaces; the exceptions are names the ecosystem already owns and
that a platform injects for you (`PORT`, `HOST`, `DATABASE_URL`, `REDIS_URL`,
`SMTP_URL`, `LOG_LEVEL`), where a prefix would break the convention rather than
protect it. The kernel's three are unprefixed because there is exactly one
kernel in a process and nothing else binds them.

A **shape** is never a variable: a plugin list, a CORS record's allowed
headers, a set of security headers. An environment carries strings, so what it
carries here is scalars.

## Any Standard Schema

`Config.object` produces a Standard Schema, and `Config.provider` accepts any
— `zod`, `valibot`, `arktype` — as long as it takes the flat environment record
and produces the port's service:

<!-- doctest: isolate
import { Config } from "@btravstack/config";
import { Port } from "@btravstack/di";
class CacheConfig extends Port("CacheConfig")<{
  readonly url: string;
  readonly ttlSeconds: number;
}> {}
-->

```ts
import { z } from "zod";

export const cacheConfig = Config.provider(CacheConfig)(
  z
    .object({
      CACHE_URL: z.string().url(),
      CACHE_TTL_SECONDS: z
        .string()
        .default("60")
        .transform(Number)
        .pipe(z.int().min(0)),
    })
    .transform((raw) => ({
      url: raw.CACHE_URL,
      ttlSeconds: raw.CACHE_TTL_SECONDS,
    })),
);
```

The fields exist so the starters, and an application with ordinary needs, bring
no schema library at all. Never call a schema's own `.parse()` — it throws,
and `unthrown/no-throw` bans it; the provider is what validates.

## See also

- [`@btravstack/config`](/reference/config) — every field, option and error.
- [runMain and exit codes](/reference/core/exit-codes) — where `78` sits among the others.
- [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) — `PORT`/`HOST` bound by a starter.
- [Test an application](/how-to/test-an-application) — `env` and the other options a test forces.
