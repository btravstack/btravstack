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
generated from your schema. Node `>=22`.

## A worked example

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";

// The stand-in for the client YOUR schema generates, and the extension you
// apply to it. Neither exists in this package — that is what the `client`
// arrow is for.
declare class PrismaClient {
  constructor(options: { readonly adapter: PrismaPg });
  $disconnect(): Promise<void>;
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
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

That is the whole surface. `database` is a **module** carrying the port a
composition root reads; the provider binding `DATABASE_URL`, the resourceful
client provider, the health check and the engine-tracing loader are inside it:

```ts
export const PersistenceModule = Module("Persistence")({
  imports: [database],
  exports: [database.port],
  needs: [Env, Logger],
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
- **A health check**, named after the starter — `SELECT 1` through `$queryRaw`,
  folded into the kernel's `GET /healthz` with nothing wired. `/readyz` does not
  read it: failing readiness on a dependency every replica shares removes them
  all at once.
- **Engine tracing, offered rather than registered.** The starter contributes a
  loader for the optional `@prisma/instrumentation` peer to `Instrumentations`;
  composing `@btravstack/observability/otel` is what turns it on, and a graph
  with no SDK never imports it. A missing peer is a `debug` line, never silence.
- **Every query handed to `Observers`**, so composing `observability()` writes
  the failures as lines and `otel()` mints the instruments — with no flag here
  and no port list to satisfy when you compose neither.

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

| Option         | Where                                       | What it is                                                                               |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `name`         | `prismaDatabase(name)`                      | the port's id and the health check's name — required                                     |
| `client`       | `prismaDatabase(name)({ client })`          | builds your client from the driver adapter this package built from the URL — required    |
| `DATABASE_URL` | environment, read by `prismaDatabase(name)` | the connection string — required, validated at graph build; blank is an error, exit `78` |

There is **no `instrumented` flag**: observation is a set port every call is
handed to, so a graph composing no observability pays one inert call and no
port list. The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/prisma),
which is this list's one detailed home.

## License

MIT
