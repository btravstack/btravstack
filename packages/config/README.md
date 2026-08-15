# @btravstack/config

**Configuration the twelve-factor way, for [`@btravstack/di`](../di): typed
values bound from the environment, validated once, injected like any other
service.**

The environment is a port (`Env`); a configuration slice is a port bound from
it through a schema (`Config.provider`); the schema is either the fields this
package ships (`Config.object({...})`, no schema library needed) or any
Standard Schema. A bad environment is a modeled `ConfigInvalid` naming every
offending variable — which [`@btravstack/core`](../core)'s `runMain` turns
into a `startFailed` event and exit code `78`.

## Install

```sh
pnpm add @btravstack/config @btravstack/di unthrown
```

`@btravstack/di` and `unthrown` are peer dependencies. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A slice of the environment, as a port

```ts
import { Config } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";

const databaseConfig = Config.provider("DatabaseConfig")(Config.object({
    url: Config.string("DATABASE_URL"),
    poolSize: Config.integer("DATABASE_POOL_SIZE", { min: 1, max: 64, default: 8 }),
    ssl: Config.boolean("DATABASE_SSL", { default: true }),
  }),
);

const Persistence = Module("Persistence")({
  provides: [
    databaseConfig,
    Provider(Database)([databaseConfig.port], { acquire: (config) => …, release: … }),
  ],
  exports: [Database],
});
```

`Config.provider("DatabaseConfig")(schema)` mints the port — its service is
the schema's output, `{ url: string; poolSize: number; ssl: boolean }` — and
hands back the provider carrying it: `databaseConfig.port` is what a
dependent lists in its deps. That is the shape for a slice that is one
application's own. A slice that is public API — a starter's `HttpConfig`,
which other packages name — declares its port and passes the class instead:
`Config.provider(HttpConfig)(schema)`; same provider, same schema, the port
named once either way.

`Env` is what `Config.provider` reads. Under `@btravstack/core` the kernel
provides it to every graph it boots — `process.env`, or `StartOptions.env` for
a test — so the module above declares an `Env` need the kernel discharges, the
same way it discharges `Scope`. Anywhere else, provide it yourself:
`Provider(Env)({ value: process.env })`.

## Fields

| Field                                           | Value                                                           |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `Config.string(VAR, { default? })`              | a non-empty string                                              |
| `Config.integer(VAR, { min?, max?, default? })` | a whole number, bounds inclusive                                |
| `Config.port(VAR, { default? })`                | a whole number in `0..65535` — `0` (an ephemeral bind) included |
| `Config.boolean(VAR, { default? })`             | `true/false`, `1/0`, `yes/no`, `on/off`, case-insensitively     |

Semantics that hold for every field, pinned by the package's own spec:

- **Unset** → the `default`, or `is required` when there is none.
- **Set but empty or blank** → an error, never the default. `Number("")` is
  `0`, so `PORT=` would otherwise bind the ephemeral port; a port's floor is
  `0` precisely so an ephemeral bind stays expressible, which is why that guard
  cannot be a lower bound.
- `abc`, `3.5` and out-of-range values are named, not truncated or `NaN`'d.
- Every field is read before answering, so one validation names every fault at
  once — an operator fixes the deployment in one round trip.

## Any Standard Schema

`Config.object` produces a Standard Schema; `Config.provider` accepts any —
`zod`, `valibot`, `arktype` — as long as it takes the flat environment record
and produces the port's service:

```ts
Config.provider(DatabaseConfig)(z.object({ DATABASE_URL: z.string().url(), … }).transform(…));
```

## Errors

`ConfigInvalid` — `{ port, issues }` — is the one error `Config.provider`
answers. Its `message` is one line per issue, naming the variable:

```
DatabaseConfig could not be configured:
  DATABASE_URL: is required
  DATABASE_POOL_SIZE: must be between 1 and 64, got 100
```

`ConfigFieldInvalid` — `{ reason }` — is what a single field's `parse` answers;
you meet it only when writing a field of your own (`ConfigField<T>` is
`{ variable, parse(raw) }`).

## License

[MIT](./LICENSE) © Benoit TRAVERS
