# packages/prisma

The Prisma starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/prisma/`.

## Public surface

- **`prismaDatabase(name)({ client, urlVar? })`** (`prisma.ts`) — the whole
  surface, returning `{ port, config, provider }`. A composition root puts
  `config` and `provider` in `provides` and exports `port`; there is nothing
  else to wire.
  - `client: (adapter: PrismaPg, url: string) => C` is **the one thing this
    package cannot own**. A Prisma client is generated per application from its
    own schema, so no client type is shippable — which is also why the
    `@btravstack/cache` shape (a fixed `CacheService`, a memory adapter and a
    real one) does not apply here, and why issue #135's adapter-seam option was
    refused. Applying `@unthrown/prisma`'s extension belongs in this arrow too,
    so the port is typed by exactly what the application will hold.
  - `urlVar` defaults to `"DATABASE_URL"`. It exists so two databases in one
    application do not collide on one variable; the config port's own name is
    derived from `name`, so those never collide.
  - `C` is constrained by **`PrismaLike`** — `{ $disconnect(): Promise<void> }`,
    and nothing more. A generated client satisfies it structurally, and so does
    an extended one, since `$extends` preserves `$disconnect`.

- **The port is a CAST, not a class expression**, and this is not style:
  `Port(name) as PortClassOf<N, C>`. A class expression's type expands di's
  brand keys into a consumer's declaration emit, where they cannot be named, and
  `pnpm build` fails with **TS4023** — measured here, not anticipated. It is the
  same reason `HttpRouterPort` is a cast in `@btravstack/http-server`, and the
  class of bug `examples/hexagonal-order-api`'s emit guards exist to catch.

- **The provider is resourceful.** `acquire` builds the client, `release` is
  `$disconnect`. The error channel is **empty** because opening cannot fail in
  the application's terms — Prisma dials on the first statement, not here.
  `$disconnect` ends the driver adapter's pool without killing the client, which
  is why no spec asserts that a released client refuses to query.

## Not included, deliberately

**Migrations**, because a deployment runs `prisma migrate deploy` before the
process starts and an application that migrates at boot races its own replicas.
**Transactions**, because commit boundaries belong to the adapter and
`@unthrown/prisma`'s `$tryTransaction` is already the primitive. **A health
contribution**, because `start.ts`'s `ready()` is
`tracker.current() === "serving" && !forcedUnready` with no hook to contribute
to — adding one is a kernel change and a contested one, since a pod that cannot
reach its database arguably should stay ready and fail requests rather than flap
out of the endpoint list.

## No peer on `@btravstack/core`, and no instrumentation

The other three application-service ports — `cache`, `mailer`, `storage` — each
peer on `@btravstack/core` because their `instrumented` flag reads `Logger`,
`Tracer` and `Meter` from it. This one imports nothing from `core` and so does
not declare it, which knip enforces.

That follows from having no instrumentation, and **that** follows from the same
fact as the missing adapter seam: the surface is a generated client, not a
four-method port. Wrapping every model method of a schema this package cannot
see is not something it can do, and a span around `acquire` would time the
constructor rather than a query. Instrumentation belongs where the queries are
written — the repository adapters — where `@unthrown/prisma` already returns a
`Result` to hang it on.

## Tests need no container

`vitest.config.ts` names no `globalSetup`, and that is the point rather than an
omission: a Prisma client dials on the first statement, so the pool's lifecycle
— all this package owns — is provable against a stub client with a
`$disconnect` counter. A database here would be testing Prisma. The real
database exercise lives in `examples/order-infrastructure`, which consumes this
package and runs against the shared PostgreSQL container.
