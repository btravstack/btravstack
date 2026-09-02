# @btravstack/config

> Configuration the twelve-factor way, for [`@btravstack/di`](../di): typed
> values bound from the environment, validated once as the graph is built,
> injected like any other service. A bad environment is a modeled
> `ConfigInvalid` naming every offending variable — which
> [`@btravstack/core`](../core)'s `runMain` reports as a `startFailed` event and
> exit code `78`.

📖 **[Documentation](https://btravstack.github.io/btravstack/how-to/configure-from-the-environment)** ·
[Reference](https://btravstack.github.io/btravstack/reference/config) ·
[API Reference](https://btravstack.github.io/btravstack/api/config/)

```sh
pnpm add @btravstack/config @btravstack/di unthrown
```

`@btravstack/di` and `unthrown` are peer dependencies; the package depends on
nothing else — `Config.object` is a hand-rolled Standard Schema. Node `>=22`.

## A slice of the environment, as a port

<!-- doctest: prelude
import { Port } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
type DatabaseClient = { readonly close: () => void };
class Database extends Port("Database")<DatabaseClient> {}
declare const openDatabase: (url: string) => AsyncResult<DatabaseClient, never>;
-->

```ts
import { Config, Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";

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

const Persistence = Module("Persistence")({
  needs: [Env],
  provides: [
    databaseConfig,
    Provider(Database)({
      inject: { config: databaseConfig.port },
      acquire: ({ config }) => openDatabase(config.url),
      release: (db) => db.close(),
    }),
  ],
  exports: [Database],
});
```

`Config.provider("DatabaseConfig")(schema)` mints the port — its service is the
schema's output, `{ url: string; poolSize: number }` — and hands back the
provider carrying it: `databaseConfig.port` is what a dependent lists in its
deps. A slice that is public API — a starter's `HttpConfig`, which other
packages name — declares its port and passes the class instead:
`Config.provider(HttpConfig)(schema)`.

`Env` is what `Config.provider` reads. Under `@btravstack/core` the kernel
provides it to every graph it boots — `process.env`, or `StartOptions.env` for
a test. Anywhere else, provide it yourself: `Provider(Env)({ inject: {}, value: process.env })`.

## Fields

| Field                                           | Value                                                           |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `Config.string(VAR, { default? })`              | a non-empty string                                              |
| `Config.integer(VAR, { min?, max?, default? })` | a whole number, bounds inclusive                                |
| `Config.boolean(VAR, { default? })`             | a flag: `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`         |
| `Config.port(VAR, { default? })`                | a whole number in `0..65535` — `0` (an ephemeral bind) included |

An unset variable takes its `default` (or `is required`); a **set but empty or
blank** one is an error, never the default; `abc`, `3.5` and out-of-range
values are named; every field is read before answering, so one validation
names every fault at once. `Config.pinned(value, field)` is how a starter's
option beats the environment, per field — and where the field carries a rule
about the VALUE (`integer`, `port`), the pin is checked by it, so a bound a
deployment could not cross is not one a composition root can pin either.
`Config.string` deliberately carries none: "set but empty" is about the raw
variable, where a pinned `""` is a decision (`http({ cors: false })` pins
exactly that). Any Standard Schema (`zod`,
`valibot`, `arktype`) is accepted in place of `Config.object`. The full
semantics, `ConfigInvalid`'s message and `ConfigFieldInvalid` are on the
[documentation site](https://btravstack.github.io/btravstack/reference/config).

## License

[MIT](./LICENSE) © Benoit TRAVERS
