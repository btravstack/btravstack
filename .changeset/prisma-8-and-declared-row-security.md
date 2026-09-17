---
"@btravstack/prisma": major
"@btravstack/observability": patch
---

Moved the persistence starter to **Prisma 8**, which is a different package
family rather than a version bump: `@prisma/orm-postgres` is the one peer, and
`@prisma/client`, `@prisma/adapter-pg` and `@prisma/instrumentation` have no
successor. `@unthrown/prisma` peers on `@prisma/client@^7`, so it goes with
them. Consumers on Prisma 7 stay on `@btravstack/prisma@0.14`.

**`client` now receives a binding rather than a driver adapter.**
`prismaDatabase(name)({ client: ({ url, middleware }) => postgres({
contractJson, url, middleware }) })`. The middleware in that binding is the
starter's own `afterQuery` hook — spread it in, or the queries go unobserved.
`PrismaLike` requires `raw` and `runtime` to exist and describes neither, which
is measured rather than lazy: a parameter is contravariant, and the real
signatures name contract types no package that cannot see a contract could
spell.

**Row-level security is DECLARED.** `@@rls` on the model plus a
`policy_<operation>` block in the contract, planned and applied as ordinary
migration operations. The whole of `tenantScoped` is gone — the client
extension, the `$allOperations` hook, the pre-extension-client recursion guard,
the `this`-polymorphic `$transaction` override, the `$transaction([...])`
refusal and the hand-copied `ITXClientDenyList`. What replaces it is
`tenantPinned(db, tenant, work)`, which opens the transaction the
`set_config(…, true)` is local to.

**That it opens a transaction is the design, not an implementation detail.** A
session-scoped pin followed by a separate query was measured to work — and only
because the pool happened to hand back the same connection. It is the shape a
`beforeQuery` middleware would have taken, and it fails silently under
concurrency, which is why there is no middleware.

**New: `@btravstack/prisma/result`.** Prisma 8 throws a structured error
carrying PostgreSQL's own SQLSTATE, so `tryQuery(() => query)` answers a
`Result` with three modeled arms — `UniqueConstraintViolation` (`23505`, with
the `constraint` the database named, which `P2002` could not say),
`ForeignKeyViolation` (`23503`) and `NotAuthorized` (`42501`, a write the
policy's `WITH CHECK` refused). Anything else is a defect. It takes a **thunk**,
because an `AsyncResult` is eager. The module imports `unthrown` and nothing
else, so it can move to that repository whole once Prisma 8 is stable.

**Engine tracing is gone with the engine.** Prisma 8 is a TypeScript runtime
and ships no telemetry package, so `instrument.ts` and `tracing.ts` collapse
into one `afterQuery` middleware feeding `Observers` — which sees the ORM lane,
the SQL builder and the raw lane alike, where the v7 `$allModels` wrapper saw
only the first, and carries the runtime's own `latencyMs`. `Instrumentations`
leaves the module's exports and `Logger` leaves its needs, since the one `debug`
line it existed for has nothing left to report.

**Two gaps are Prisma 8's and are documented rather than worked around.** It
emits `ENABLE ROW LEVEL SECURITY` with no way to express `FORCE`, so the
table's owner — the role that ran the migrations — bypasses every policy, and a
deployment must connect as a non-owner; and it authors no `GRANT`s. Both fail
quietly, which is why `examples/order-infrastructure` carries "is neither a
superuser nor exempt from row security" as a standing test.

`@btravstack/observability`'s `@opentelemetry/sdk-node` peer moves to
`^0.222.0`, matching the version the catalog has installed since the last bump.
`^0.221.0` excluded it, which a frozen lockfile was hiding.
