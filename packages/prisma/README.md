# @btravstack/prisma

> The Prisma starter for [`@btravstack/core`](https://github.com/btravstack/btravstack):
> `DATABASE_URL` bound through `Config`, the Postgres driver adapter, and a
> client whose pool is the application scope's.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/prisma)** ·
[API Reference](https://btravstack.github.io/btravstack/api/prisma/)

```sh
pnpm add @btravstack/prisma @btravstack/core @btravstack/config @btravstack/di unthrown \
  @prisma/adapter-pg
```

Five peer dependencies — install every one, so the application holds a single
copy of each. Your own `@prisma/client`, `prisma` and (if you want the `try*`
twins) `@unthrown/prisma` are yours, not this package's: the client is
generated from your schema. Node `>=20`.

## A worked example

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Logger, Meter, Tracer } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";

// The stand-in for the client YOUR schema generates, and the extension you
// apply to it. Neither exists in this package — that is what the `client`
// arrow is for.
declare class PrismaClient {
  constructor(options: { readonly adapter: PrismaPg });
  $disconnect(): Promise<void>;
  $extends(extension: unknown): this;
}
declare const unthrownPrisma: unknown;
-->

```ts
import { prismaDatabase } from "@btravstack/prisma";

const database = prismaDatabase("OrderDatabase")({
  client: (adapter) => new PrismaClient({ adapter }).$extends(unthrownPrisma),
});
```

That is the whole surface. `database` carries three pieces, and a composition
root wants all three:

```ts
export const DatabaseModule = Module("Database")({
  provides: [database.config, database.provider],
  exports: [database.port],
  needs: [Env, Logger, Meter, Tracer],
});
```

**The client type is yours, and that is deliberate.** A Prisma client is
generated from _your_ schema, so there is none for this package to ship — the
`client` arrow is where your generated class and your extensions meet, and the
port is typed by exactly what it returns.

## What it owns

- **`DATABASE_URL` through `Config`.** A missing or blank value is a modeled
  `ConfigInvalid` naming the variable, not a throw — so a misconfigured
  deployment exits `78` with the reason on stderr instead of crashing on the
  first query.
- **The Postgres driver adapter**, constructed from that URL. Another driver is
  reachable — build it in your own `client` arrow and ignore the one passed in.
- **The pool's lifetime.** The provider is _resourceful_, so `release` closes it
  on every exit path, including a boot that fails after it ran.

## What it does not

**Migrations.** A deployment runs `prisma migrate deploy` against this same URL
_before the process starts_. An application that migrates itself at boot races
every other replica.

**Transactions.** Commit boundaries belong to the adapter, spelled at the call —
`@unthrown/prisma`'s `$tryTransaction` is the primitive. There is no unit-scoped
transaction and there will not be one; see
[the kernel maps nothing](https://btravstack.github.io/btravstack/explanation/the-kernel-maps-nothing).

**A repository base class.** Ports are your application's vocabulary, not this
package's.

## Options

| Option   | Default          | What it does                                       |
| -------- | ---------------- | -------------------------------------------------- |
| `client` | —                | Builds the client from the driver adapter and URL. |
| `urlVar` | `"DATABASE_URL"` | The variable the connection string is read from.   |

## License

MIT
