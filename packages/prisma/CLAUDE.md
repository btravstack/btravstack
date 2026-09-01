# packages/prisma

The Prisma starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/prisma/`.

## Public surface

- **`prismaDatabase(name)({ client })` → the module, augmented with `port`** (`prisma.ts`) — the whole
  surface, returning `{ port, config, provider }`. A composition root puts
  `config` and `provider` in `provides` and exports `port`; there is nothing
  else to wire.
  - `client: (adapter: PrismaPg) => C` is **the one thing this
    package cannot own**. A Prisma client is generated per application from its
    own schema, so no client type is shippable — which is also why the
    `@btravstack/cache` shape (a fixed `CacheService`, a memory adapter and a
    real one) does not apply here, and why issue #135's adapter-seam option was
    refused. Applying `@unthrown/prisma`'s extension belongs in this arrow too,
    so the port is typed by exactly what the application will hold.
  - `C` is constrained by **`PrismaLike`** — `{ $disconnect(): Promise<void> }`,
    and nothing more. A generated client satisfies it structurally, and so does
    an extended one, since `$extends` preserves `$disconnect`.

- **The port is a CAST, not a class expression**, and this is not style:
  `Port(name) as PortClassOf<N, C>`. A class expression's type expands di's
  brand keys into a consumer's declaration emit, where they cannot be named, and
  `pnpm build` fails with **TS4023** — measured here, not anticipated. It is the
  same reason `OrpcRouterPort` is a cast in `@btravstack/http-server`, and the
  class of bug `examples/di-hexagonal`'s emit guards exist to catch.

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

## Instrumentation, on the family's shape

Every query is handed to `Observers`, and the operation says `traced: false`:
engine-level tracing is `@prisma/instrumentation`'s job and a client-level span
would carry strictly less beside it. The module needs `Env` and `Logger` —
`Logger` for exactly one line, the `debug` saying engine tracing is off because
the optional peer is absent, which is a STARTUP fact rather than an operation an
observer could settle.

**It emits no span, deliberately.** `@btravstack/prisma/otel`'s `prismaTracing()`
enables Prisma's own `@prisma/instrumentation`, which traces at the ENGINE level
— the real SQL, the connection acquisition, the serialisation. A client-level
span here would sit beside it on every query carrying strictly less. What the
wrapper keeps is the pair Prisma's instrumentation does not do at all: a metric,
and an error line correlated with the ambient unit.

**Engine tracing turns itself on**, with no wiring at a composition root: the
loader calls `enableTracing`, which **dynamically imports**
`@prisma/instrumentation` and enables it. The import has to be dynamic — the
package is an OPTIONAL peer, and a static import would make every consumer
install it. A failure to resolve is an ordinary answer, logged at `debug`; the
skip is never silent, because telemetry you believe you have and do not is
worse than none. `tracing.ts` takes its loader as a parameter so both arms are
testable.

It can be a provider at all because `@prisma/instrumentation` does **not** patch
modules: `enable()` sets a helper on `globalThis` under a versioned key and a
client looks it up per query, so registration order is free. The `--import`
preload rule in `packages/observability/CLAUDE.md` governs patching
instrumentations and does not reach this one — a distinction worth keeping
straight, since an earlier revision applied that rule here without checking
whether it belonged. The `Tracer` dependency is for ORDERING, not value: it is
what forces `otel()`'s SDK up first.

**A generated client can be observed, and an earlier revision of this file
said it could not.** That claim — repeated in issue #135's decision comment —
missed Prisma's own mechanism: `$extends` takes a `query` component, and
`$allModels.$allOperations` intercepts every operation on every model. The
wrapper therefore never needs to know the schema, which is the one thing this
package cannot see. The seam that genuinely does not exist is the _adapter_
one; instrumentation was never blocked by it, and the two were wrongly argued
together.

**The branch is inside `acquire`, not between two ports.** `cache` needs
`Cache` and `CacheBackend` because di allows one provider per port per graph, so
its observed form has to layer over the plain one. Here the extension wraps
the client at construction, so one port suffices. Both provider arms are built
and one is chosen, which is how the conditional return type gets spelled by the
arms themselves instead of by naming di's provider type.

`instrument` re-raises with **`Promise.reject`, never `throw`** — the rejection
must reach `@unthrown/prisma`'s `try*` twin unchanged, and rejecting does that
without the file needing a `no-throw` exemption.

The extended client is cast back to `C`: a `query`-only extension intercepts
calls without adding or removing model surface, which `$extends`'s own return
type — built for extensions that DO add surface — cannot express.

## Tests need no container

`vitest.config.ts` names no `globalSetup`, and that is the point rather than an
omission: a Prisma client dials on the first statement, so the pool's lifecycle
— all this package owns — is provable against a stub client with a
`$disconnect` counter. A database here would be testing Prisma. The real
database exercise lives in `examples/order-infrastructure`, which consumes this
package and runs against the shared PostgreSQL container.

## Health check

The starter contributes one `HealthChecks` member, named `the database (named after the starter)`, so the
kernel's `/healthz` reports on it without the application wiring anything. The
probe is `SELECT 1` through `$queryRaw` — not `$connect()`, because a pooled client reports connected while the server behind it is gone.

Composing the starter therefore exports `HealthChecks` alongside its own port —
a composition root that re-exports the module whole passes it up to the kernel
with no extra line.

## Engine tracing is offered, not registered

This package contributes a loader for `@prisma/instrumentation` to
`Instrumentations`
instead of enabling it while the client is built. Composing this starter
declares engine tracing; composing `@btravstack/observability/otel` is what
turns it on, and a graph with no SDK never loads the package at all.

The optional peer is still dynamically imported, and a missing one is still
logged at `debug` rather than failing — the contributor owns that message,
since it is the one that knows why the load answered nothing.

`Tracer` is no longer in this module's `needs`. It was there for
ORDERING, to guarantee the SDK was up before the instrumentation was enabled;
the SDK now does the registering, so the ordering is inherent. `Meter` is what
still orders this after `otel()`.
