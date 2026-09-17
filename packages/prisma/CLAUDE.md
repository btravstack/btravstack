# packages/prisma

The Prisma starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/prisma/`.

**This package is on Prisma 8**, which is a different package family rather than
a version bump: `@prisma/orm-postgres` is the one peer, and `@prisma/client`,
`@prisma/adapter-pg` and `@prisma/instrumentation` have no successor. It is
pinned to an exact release candidate in the catalog for the reason oRPC's beta
is — the surface moves between candidates.

**`@prisma/orm-postgres` ships its own agent skill**, at
`node_modules/@prisma/orm-postgres/skills/prisma-8/`, which states that it is
the source of truth for the exact installed version and to prefer it over
anything remembered about Prisma. Read it before changing anything here;
`prisma skills sync` keeps it aligned. Its `references/runtime.md` covers the
client factory and middleware, `references/queries-postgres.md` the two lanes,
and `references/supabase.md` the RLS authoring surface — which is core PSL
despite living on that page.

## Public surface

- **`prismaDatabase(name)({ client })`**: its signature, what it needs and
  exports, and the `PrismaLike` constraint on its client are
  `docs/reference/prisma.md`'s and `src/prisma.ts`'s TSDoc — including why
  `client` is the one thing this package cannot own. What follows from that:
  the `@btravstack/cache` shape (a fixed `CacheService`, a memory adapter and a
  real one) does not apply here, and issue #135's adapter-seam option was
  refused.

- The port is a cast rather than a class expression, and the provider is
  resourceful with an empty error channel: the comments and TSDoc in
  `src/prisma.ts` say why.

**Nothing here imports `@prisma/orm-postgres`, and it is still a peer.** Every
shape this package needs of a client is structural, so there is no import and
knip reports the dependency unused — `knip.json` ignores it for this workspace
deliberately. The peer stays because the BEHAVIOUR is version-specific:
`affectedCount().build()`, `middleware` as a construction option,
`runtime().close()` and the raw lane's tagged template are all Prisma 8's, and
a range is the only place that can be said to an installer.

**`PrismaLike` describes almost nothing, and that is measured rather than
lazy.** It requires `raw.sql` and `runtime` to EXIST and types neither. A
parameter is contravariant, so spelling either signature out refuses every real
client: the genuine `raw.sql` takes the target's own `RawSqlInterpolation`
union and its own `ContractRawRowSpec`, both narrower than anything a package
that cannot see a contract could name, and `runtime().query` takes the
contract's own `SqlOrmPlan`. Every attempt to describe them produced
`Type 'unknown' is not assignable to type 'SqlOrmPlan<unknown>'` on the
example's own client. What the starter actually does with them goes through one
cast, `probeable`, whose type is spelled once beside it. A client missing
either member is still a compile error, which is the whole job of the
constraint.

**The health probe is `SELECT 1` terminated by `affectedCount().build()`, run
through `runtime().query`.** Three things about that are deliberate:
`affectedCount` decodes no row, so the probe needs no codec the application's
contract may not have registered (`pg/text@1` and `pg/int4@1` are only there if
the contract uses them); the statement still RUNS, so a pooled client whose
server is gone cannot answer it, which `$connect()`-style probes could not
distinguish; and it goes to `query` rather than `execute` because
`affectedCount()`'s builder answers `build(): SqlQueryPlan<AffectedCount>` — a
query plan despite the name. That last one cost a round of red typechecks.

### `@btravstack/prisma/result`

The unthrown bridge, and **it imports `unthrown` and nothing else** — no
`@btravstack/*`, no `@prisma/*`. That is not tidiness: this module is meant to
move to the `unthrown` repository as a package of its own once Prisma 8 is
stable (issue #327), and an import from here would make that a port rather than
a file move. The Prisma error shape it reads is declared structurally
(`SqlQueryErrorLike`) for the same reason.

**It keys on SQLSTATE, not on a vendor code**, which is the improvement Prisma
8 handed us: `23505` arrives with the `constraint` the database named, where
v7's `P2002` could not say which unique index fired. Three arms —
`UniqueConstraintViolation`, `ForeignKeyViolation`, `NotAuthorized` — and
everything else is a defect, because a syntax error, a dead connection or a
deadlock is infrastructure a caller cannot act on differently.

**`tryQuery` takes a THUNK.** An `AsyncResult` is eager, so a promise built at
the call site has already started before the Result exists — the hazard
`unthrown/no-async-result-race` reports one layer up. The thunk is wrapped in
`Promise.resolve().then(run)` rather than called directly, so a SYNCHRONOUS
throw from it lands on the Result's channel instead of escaping as a real
throw, which is the one channel this function exists to close.

### `@btravstack/prisma/rls`

**Row-level security is now two declarations, and this package owns the
smaller one.** The POLICY is in the application's contract — `@@rls` on the
model plus a `policy_<operation>` block — and Prisma's planner emits `ENABLE
ROW LEVEL SECURITY` and `CREATE POLICY` as ordinary migration operations. What
is left here is the PIN.

- **`tenantPinned(db, tenant, work, { setting? })`** runs `work` inside a
  transaction whose connection carries
  `set_config(setting, tenant, true)`. `setting` defaults to `app.tenant_id`,
  and the policy must read the **same** name: a mismatch denies every row and
  every write, which looks exactly like row security working.

**It opens a transaction because the pin is transaction-local, and that is the
whole design.** A session-scoped pin (`set_config(..., false)`) followed by a
separate query was measured to work — and only because the pool happened to
hand back the same connection. That is the shape a `beforeQuery` middleware
would have taken, and it is why there is no middleware here: it fails silently
under concurrency, which is the worst possible failure for this feature.

**What this replaced is worth knowing, because it was a lot.** The Prisma 7
`tenantScoped` was a `Prisma.defineExtension` carrying: a `$allOperations`
query hook (so raw SQL was pinned too), a recursion guard that issued every
`set_config` through the PRE-extension client, a `$transaction` override that
was `this`-polymorphic to keep `tx` typed, a refusal of `$transaction([...])`
because the array form could not be pinned atomically, and a hand-copied
`ITXClientDenyList` held honest by a type-test gate. None of it survives, and
none of it is missed: Prisma 8's own transaction does the work.

**The casts inside are the same kind as `probeable`'s**, and for the same
contravariance reason — `Raw` for the tagged template, and one on `tx` for
`query`. The public `Pinnable<Tx>` requires `raw.sql` to exist and describes it
no further.

**Its spec is stubbed, by this package's own rule** (no container, which
`vitest.config.ts` explains). What `rls.spec.ts` pins is the MECHANICS: that
the pin is the FIRST statement, that it runs in the SAME transaction as the
work, that `set_config`'s third argument is `true`, and that the setting name
is the option's. What it cannot prove is that PostgreSQL then refuses the row,
and that proof is deliberately elsewhere: it needs a `NOSUPERUSER NOBYPASSRLS`
role and a policy, both of which belong to the application. It lives in
`examples/order-infrastructure`, against the shared container.

**Two gaps are Prisma 8's and are documented rather than worked around:**

1. **There is no `FORCE ROW LEVEL SECURITY`.** `@@rls` emits `ENABLE` only —
   grepping the whole runtime turns up `ENABLE`/`DISABLE` and nothing else — so
   the table's OWNER bypasses every policy, and the owner is the role that ran
   the migrations. What closes it is connecting as a non-owner, which
   `internal/test-infra`'s `provisionApplicationRole` already provisions and
   `examples/order-infrastructure/src/rls.spec.ts` pins as a standing test.
   `schema-drift.spec.ts` asserts `forced: false` deliberately, so the day
   Prisma ships `FORCE` the spec goes red and says so.
2. **Grants are not authored.** Prisma 8's own documentation says it writes
   policies and not `GRANT`s; a role with policies and no grant gets a
   permission error rather than filtered rows.

## The example declares a namespace, and the usual reason is wrong

`examples/order-infrastructure`'s contract wraps its models in
`namespace orders { … }`. The folklore reason — `public` is world-writable —
is a PostgreSQL 14 fact: 15 revoked `CREATE` from `PUBLIC`, and measured on
this repository's own 18.1 container `orders_app` already cannot create there
(`has_schema_privilege(…,'public','CREATE') → f`). Do not restate it.

The reason that holds is that a shared database is the ordinary end state and
moving a live table between schemas later is a downtime-risk migration, where
declaring one in the first migration costs a block. Grants scope to the schema
as a consequence, which is why `provisionApplicationRole` grants
`IN SCHEMA orders` and nothing on `public`.

Two mechanics worth knowing before editing the contract: a `policy_*` block
must sit INSIDE the namespace it polices and name its target unqualified
(`target = orders.Order` from the top level is
`PSL_INVALID_EXTENSION_BLOCK_MEMBER`), and the planner still emits a
`Create schema "public"` operation even when nothing lives there — harmless and
idempotent, not a sign the namespace was ignored.

## The `db` ref is committed, and only the AUTHORING command moves it

`migration plan` diffs the contract against an origin: an explicit `--from`,
else the **`db` ref** (`migrations/app/refs/db.json`, a committed file holding
the contract hash a dev database has been brought to), else the empty database.

Three measured facts decide how this repository uses it:

1. **With no ref and migrations on disk, `migration plan` REFUSES** —
   `MIGRATION.PLAN_ORIGIN_UNKNOWN` — rather than writing a recreate-everything
   package. So the absence of a ref is loud, not silent.
2. **With a stale ref, the next plan re-includes the migration already
   shipped.** Measured on `examples/order-infrastructure`: leaving the ref at
   the previous head made a second plan `2 operations` instead of `1`, and
   such a migration cannot apply to a database that already has the first
   (`MIGRATION.PATH_UNREACHABLE`).
3. **`db migrate --advance-ref <name>` is the only apply-time advancement.**
   `db init` / `db update` advance it but are suppressed by `--db`; `db sign`
   advances it either way.

So the example ships **two** scripts and they are not interchangeable:
`db:migrate` is what a DEPLOYMENT runs and writes no file, and
`db:migrate:dev` (`--advance-ref db`) is what the author of a migration runs
against their own database. Neither the vitest `globalSetup` nor `pnpm dev`
advances the ref: both migrate a throwaway container, and a `pnpm test` that
wrote a tracked file would be a worse bug than the one it prevented.

## Engine tracing is gone, with the engine

Prisma 7's `instrument.ts` wrapped `$extends({ query: { $allModels:
{ $allOperations } } })` and `tracing.ts` contributed a loader for the optional
`@prisma/instrumentation` peer to `Instrumentations`. Prisma 8 is a TypeScript
runtime with no engine and explicitly ships no telemetry package, so both files
are deleted and `Instrumentations` is no longer in this module's exports.

**One `afterQuery` middleware replaces them**, and it is strictly better: a
middleware sees every lane — the ORM's, the SQL builder's and the raw one —
where `$allModels` saw only the first, and the runtime has already measured
`latencyMs` by the time the hook runs. `Logger` left the module's `needs` with
the loader, since the one `debug` line it existed for ("engine tracing is off
because the optional peer is absent") has nothing left to report.

**The middleware is a CONSTRUCTION option, not a wrapper**, which is why
`PrismaBinding` carries it: Prisma 8 has no `$extends` to layer one over a
built client, so the starter hands its hook to the application's `client` arrow
and the arrow spreads it in. An application that drops it gets no observation
and no error — that is the one thing this seam cannot enforce.

## Timestamps: the `String` variants, deliberately

`Timestamptz` and its siblings read and write `Temporal` values and throw
`RUNTIME.TEMPORAL_UNAVAILABLE` where `globalThis.Temporal` is absent — which is
every Node before 26.8.2, including every version this repository supports. The
example's contract therefore uses `TimestamptzString`, which carries
PostgreSQL's own text, and the adapter converts it to the `Date` its port
speaks. A `temporal-polyfill` import would be the alternative and is a
dependency the example does not need.

## Not included, deliberately

**Transactions**, because commit boundaries belong to the adapter and
`db.transaction(fn)` is already the primitive — the `rls` subpath is not a
counter-example: it opens one transaction to pin a setting on, and the work
inside it is the caller's.

Migrations and a readiness contribution are not here either: `src/prisma.ts`'s
TSDoc and the root's **Health checks** section say why.
