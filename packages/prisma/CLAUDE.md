# packages/prisma

The Prisma starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/prisma/`.

## Public surface

- **`prismaDatabase(name)({ client })` → a MODULE, augmented with `port`**
  (`prisma.ts`) — the whole surface. A composition root writes
  `imports: [database]` and exports `database.port`; the config provider, the
  resourceful client provider, the health member and the instrumentation member
  are inside it and are never the application's business, which is the bargain
  `cache({ adapter })` already makes. It needs `Env` and `Logger`, and exports
  `port`, `HealthChecks` and `Instrumentations`.
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

### `@btravstack/prisma/rls`

- **`tenantScoped(tenant, { setting? })`** — a Prisma client extension pinning
  every statement to `tenant` through a transaction-local
  `set_config(setting, tenant, true)`, so a PostgreSQL row-level-security policy
  reading `current_setting('app.tenant_id', true)` sees it. `setting` defaults
  to `app.tenant_id`. Also exported: `TenantScopedOptions`, and the two types
  that make the override's `tx` nameable, `ScopedTransaction` and
  `TransactionClient<C>`.
- It is a **subpath**, on the family's optional-peer protocol: `@prisma/client`
  is an optional peer, `rls.ts` is the only file importing it (from
  `@prisma/client/extension`, which is where `@unthrown/prisma` takes `Prisma`
  from too), and the main entry point never does.

**Applied LAST.** The `$transaction` override runs the callback on a `tx` from
the client as it stood when this extension was applied, so **any extension added
after `tenantScoped` is invisible inside a transaction** — measured:
`tenantScoped` before `unthrownPrisma` reaches the override and then fails with
`TypeError: tx.order.tryFindMany is not a function`.

**No re-entry marker, and none is needed.** The `query` hook is the TOP-LEVEL
`$allOperations` — that is what makes raw SQL pinned too — so it sees the
extension's own `$executeRaw`. Issuing every `set_config` through the
**pre-extension** client is what stops the recursion: that client carries none
of these hooks. The `AsyncLocalStorage` flag the design first called for was
measured to work and then deleted, because a statement inside the override's own
transaction never reaches the hook either — `bare`'s `tx` predates the
extension. The self-referential shape Prisma's own RLS documentation shows does
recurse without bound here, because their example hooks `$allModels`, which
never sees raw SQL.

**`$transaction([...])` is refused**, with a rejected promise carrying
`tenantScoped: $transaction([...]) is unsupported — use the callback form.` — a
rejection rather than a `throw`, which `unthrown/no-throw` bans and which
`$tryTransaction` turns into a `Defect` anyway. The array form cannot be pinned:
the query hook answers a plain `Promise` rather than a `PrismaPromise`, so every
element has already run — each in a wrapping transaction of its own — before
`$transaction` sees the array. Measured, a failing second element left the first
element's row committed where vanilla Prisma rolled it back. A batch that stops
being atomic without saying so is worse than one that refuses.

**The override's type is `this`-polymorphic, and that is what keeps `tx`
typed.** Three casts live in `rls.ts` and each carries a one-line guard comment;
the second is the one with a measurement behind it. Without it the
implementation's own signature is what a consumer sees and every caller's `tx`
becomes an implicit `any` (`TS7006`, reproduced by deleting the cast). The
spike's target for it — `(typeof client)["$transaction"]` — is wrong **here**:
the spike read `Prisma` off a generated client, where that indexed access
carries the schema's own delegates, while this package must read it off
`@prisma/client/extension`, where it resolves to
`Omit<PrismaClientExtends<DefaultArgs>, …>` and `tx.order` stops existing. So the
cast targets `ScopedTransaction`, `<C, R>(this: C, fn: (tx: TransactionClient<C>)
=> Promise<R>)` — the same trick `@unthrown/prisma` uses for `$tryTransaction`,
and the only place the client's type can come from when the starter cannot name
a generated client. It drops the array overload too, so the refusal above is a
compile error before it is a rejected promise.

**The cost, measured: one extra round trip and one explicit transaction per
statement outside a transaction.** `set_config(…, true)` is transaction-local
and has to be — the tenant varies per unit while a pooled connection does not —
so an unpinned statement is wrapped in a two-element batch. A statement already
inside a `$transaction` callback pays nothing: the connection is pinned once for
the whole transaction.

**Its spec is stubbed, by this package's own rule** (below): `rls.spec.ts` pins
the MECHANICS — which statements are issued, through which client, in which
order, what the hook hands back, and that the array form rejects — against the
`StubClient`. What it cannot prove is that PostgreSQL then refuses the row, and
that proof is deliberately elsewhere: it needs a `NOSUPERUSER NOBYPASSRLS` role,
`FORCE ROW LEVEL SECURITY` and a policy, all of which are the application's DDL.
It lives in `examples/order-infrastructure`, against the shared container.

## Not included, deliberately

**Migrations**, because a deployment runs `prisma migrate deploy` before the
process starts and an application that migrates at boot races its own replicas.
**Transactions**, because commit boundaries belong to the adapter and
`@unthrown/prisma`'s `$tryTransaction` is already the primitive — the `rls`
subpath's `$transaction` override is not a counter-example: it pins the tenant on
the connection the callback runs over and opens no commit boundary of its own.
**A readiness contribution** — the health member below reports on `/healthz`, and `/readyz`
deliberately does not read it: failing readiness on a dependency every replica
shares removes them all at once, turning a degraded system into an outage.

## Instrumentation, on the family's shape

Every query is handed to `Observers`, and the operation says `traced: false`:
engine-level tracing is `@prisma/instrumentation`'s job and a client-level span
would carry strictly less beside it. The module needs `Env` and `Logger` —
`Logger` for exactly one line, the `debug` saying engine tracing is off because
the optional peer is absent, which is a STARTUP fact rather than an operation an
observer could settle.

**It emits no span, deliberately.** The `Instrumentations` member below loads
Prisma's own `@prisma/instrumentation`, which traces at the ENGINE level
— the real SQL, the connection acquisition, the serialisation. A client-level
span here would sit beside it on every query carrying strictly less. What the
wrapper keeps is the pair Prisma's instrumentation does not do at all: a metric,
and an error line correlated with the ambient unit.

**Engine tracing turns itself on**, with no wiring at a composition root:
`loadPrismaInstrumentation` **dynamically imports**
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
instrumentations and does not reach this one.

**A generated client is observable because Prisma says so**: `$extends` takes a
`query` component, and `$allModels.$allOperations` intercepts every operation on
every model, so the wrapper never needs to know the schema — the one thing this
package cannot see. The seam that genuinely does not exist is the ADAPTER one,
which is a different argument and the reason issue #135's adapter-seam option
was refused.

**The wrapper is inside `acquire`, not between two ports.** `cache` needs
`Cache` and `CacheBackend` because di allows one provider per port per graph, so
its observed form has to layer over the plain one. Here the extension wraps the
client at construction, so one port suffices and there is nothing to layer.

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

The starter contributes one `HealthChecks` member, named after the starter
itself (`prismaDatabase("OrderDatabase")` contributes `OrderDatabase`), so the
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

**Neither `Tracer` nor `Meter` is in this module's `needs`.** A `Tracer` was
once named for ORDERING, to guarantee the SDK was up before the instrumentation
was enabled; the SDK does the registering now, so the ordering is inherent. What
the module needs is `Env` and `Logger`, and observation reaches it through the
`Observers` set port it contributes its own no-op member to.
