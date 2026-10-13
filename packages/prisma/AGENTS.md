# packages/prisma

The Node floor is `>=22.12`, matching `@prisma/cli-engine` pulled in by the
required Prisma peer.

The Prisma starter's public surface. The root `AGENTS.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/prisma/`.

**This package is on Prisma 8**, which is a different package family rather than
a version bump: `@prisma/orm-postgres` is the one peer, and `@prisma/client`,
`@prisma/adapter-pg` and `@prisma/instrumentation` have no successor. It is
pinned to an exact release candidate in the catalog for the reason oRPC's beta
is — the surface moves between candidates.

**The three catalog numbers are deliberately unaligned**, and the alignment
belongs upstream rather than here: Prisma ships three release trains and pins
across them exactly, so `prisma@8.0.0-rc.15` depends on
`@prisma/cli-engine@0.4.0` and `@prisma/orm-toolchain@8.0.0-rc.11`, while
`@prisma/orm-postgres`'s own `latest` is `8.0.0-rc.11`. Each entry is the head
of its own train. Do not "fix" them to one number — for two of the three it
names a version that was never published.

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
  resourceful, failing with `DatabaseUnreachable` when the probe it runs while
  opening goes unanswered and with `RowSecurityBypassed` when row security
  would not apply to the role: the comments and TSDoc in `src/prisma.ts` say
  why.

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
`affectedCount` decodes no row, so the probe depends on no codec at all; the statement still RUNS, so a pooled client whose
server is gone cannot answer it, which `$connect()`-style probes could not
distinguish; and it goes to `query` rather than `execute` because
`affectedCount()`'s builder answers `build(): SqlQueryPlan<AffectedCount>` — a
query plan despite the name. That last one cost a round of red typechecks.

**The client is probed while the scope opens** (issue #460), and that reverses
an earlier "no query during acquisition". Prisma 8 verifies its contract marker
on first use, on a connection of its own, so a fresh pool whose first statements
are as many concurrent transactions as it has connections deadlocks: every
connection waits on a check that cannot get one. The earlier note advised a pool
of at least two, which only covered a pool of one. Measured on
`examples/order-infrastructure`'s `database.spec.ts`: 25 concurrent transactions
on Prisma's default pool of ten committed none before the probe and all after.

- **It fails the boot with `DatabaseUnreachable`**, the way the Redis cache, the
  AMQP client and the Temporal client already do. It carries the name and the
  driver's cause, never the URL, which holds credentials. The wait is the pool's
  own `connectionTimeoutMillis`, which the application sets in its `client`
  arrow; a starter timeout would duplicate it.
- **A failed probe closes the pool itself**: `release` runs only for what was
  acquired.
- **It refuses a role row security does not apply to** (issue #498), with
  `RowSecurityBypassed`: after the probe, one statement lists every
  row-secured table the role is exempt from — as a superuser, with
  `BYPASSRLS`, or as an owner of a table that is not `FORCE`d, ownership read
  through `pg_has_role(…, 'USAGE')` so a member inheriting the owner's
  privileges counts too. It lives in the ROOT entry rather than in `/rls`
  because the boot is `prismaDatabase`'s: `/rls` composes nothing that runs at
  boot, and an application on the owner's URL is exactly one that may never
  have reached for `tenantPinned`. A database with no row-secured table
  answers no row, so the check costs those applications one statement and
  nothing else. **There is no opt-out**, because nothing in this repository
  needs one: the gate and `pnpm dev` already boot as `orders_app`, and a
  deployment that wants the owner's privileges at runtime has no use for a
  policy. **The health check does not carry it**: `/healthz` reports a
  dependency's reachability, and a role is not something that degrades under a
  running pool. It decodes three `pg/text@1` columns, a codec the Postgres
  target registers whatever the contract declares — the registry is built
  from the target, adapter and extensions, not from the contract's columns.
- **It does not catch a marker mismatch.** Prisma rc.11 warns once and carries
  on; `prisma db verify` is the deploy-time check.
- **A middleware that answers an unannotated plan would answer the probe too**,
  and the health check with it — both run the same `SELECT 1` through
  `runtime().query`. Prisma's own cache middleware cannot: it caches only plans
  carrying `cacheAnnotation`, and the probe carries none. Checking each
  answer's `source` was weighed and declined for a middleware nobody ships.

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

**A code the application raises on purpose is the one exception, and the
caller opts in** (issue #489): `raises: ["OR001"]` on `tryQuery` or
`tenantPinned` models it as `RaisedException<"OR001">`. Opt-in rather than a
fourth default arm because an unlisted code is still infrastructure — a
`P0001` from someone's forgotten debug `RAISE` is not a refusal to triage — and
because a default arm would break every exhaustive `mapErrCases` in every
consumer. `Raised<S>` distributes, so `never` (nothing listed) adds nothing —
`result.test-d.ts` pins both halves — and each listed code is its own arm.
The three modeled SQLSTATEs win over `raises`. `message` is set after
`super`, because `TaggedError` reserves it as a payload key.

**`tryQuery` takes a THUNK.** An `AsyncResult` is eager, so a promise built at
the call site has already started before the Result exists — the hazard
`unthrown/no-async-result-race` reports one layer up. The thunk is wrapped in
`Promise.resolve().then(run)` rather than called directly, so a SYNCHRONOUS
throw from it lands on the Result's channel instead of escaping as a real
throw, which is the one channel this function exists to close.

**Why this is not a Prisma extension, when Prisma 8 does have extensions.**
Two different things carry that name, and neither could host this:

- **`$extends` is gone with the engine.** There is no client wrapper in Prisma
  8, which is exactly why the v7 `tenantScoped` had to be rewritten.
- **A Prisma 8 "extension" is a contract-time package**, registered under
  `extensions:` in `prisma.config.ts`, consuming the framework SPI and
  contributing namespaced type constructors (`pgvector.Vector(1536)`), codecs,
  migration operations and middleware. The skill's `upgrade-extension.md` is
  its whole authoring flow, and `@prisma/orm-extension-middleware-cache` is a
  shipped one.

What an extension contributes is what a contract can **say** and what a
migration **emits**. The client's method types come from the emitted
`contract.d.ts`, so nothing at runtime — extension or middleware — can change
`db.orm.orders.Order.create()`'s declared return from a `Promise` to an
`AsyncResult`. Middleware runs on the PLAN, below the ORM: `interceptQuery`
substitutes rows, and never sees which method the caller invoked. That
asymmetry is why the observability half of this package IS a middleware and
this half is a call-site function.

And it would cost the module its whole point: `result.ts` imports `unthrown`
and nothing else so it can move to that repository as a file rather than a
port (issue #327). An extension would have to consume the SPI, which is a
`@prisma/*` dependency in the one module that must not have one.

### `@btravstack/prisma/rls`

**Policies stay in the application's contract.** `@@rls` on the
model plus a `policy_<operation>` block — and Prisma's planner emits `ENABLE
ROW LEVEL SECURITY` and `CREATE POLICY` as ordinary migration operations. What
is left here is the PIN, plus an optional narrow tenant-listing capability.

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

**One middleware replaces them**, on four hooks, and it is strictly better: a
middleware sees every lane — the ORM's, the SQL builder's and the raw one —
where `$allModels` saw only the first.

**It uses `beforeQuery`/`afterQuery` rather than `afterQuery` alone**, paired
by `ctx.planExecutionId` — the runtime's own correlation id, whose TSDoc names
tracing and timing as the reason it exists. The port is called at the START and
answers a finisher precisely so a span can be opened around the work; settling
an operation started in the same tick gives a zero-width span that is the
parent of nothing. It also means `latencyMs` is not passed along: the observer
started the operation, so the duration is its own. `Settled` carries no
`details` channel anyway — only bounded `attributes` — which is the port
saying the same thing.

**Both lanes, and the write one is easy to miss.** `beforeExecute` /
`afterExecute` are a separate pair: a SQL-builder statement with no
`RETURNING`, run through `runtime().execute(plan)`, never touches the query
hooks. Measured with a real client: a `delete()` plan produced
`beforeExecute` / `afterExecute` and no `afterQuery` at all.

**A failed statement DOES reach the hook**, measured rather than assumed: a
duplicate insert against a real database arrives as
`afterQuery … completed=false` before the rejection surfaces. That is what the
in-flight map depends on for its own cleanup, and why it is not a leak. `Logger` left the module's `needs` with
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

Running migrations and a readiness contribution are not here either: `src/prisma.ts`'s
TSDoc and the root's **Health checks** section say why.

### A narrow tenant-listing capability

`tenantListing` on `/rls` returns a Result containing a structural `rawSql`
operation definition and a typed `list(db, after?)` query. The package still imports
no Prisma runtime. The operation targets the table's `rlsPolicy`, because the
installed Prisma target's metadata has no function object kind. Functions are
not contract elements; the generated raw operation belongs in the application's
reviewed migration, never in process boot.

The declaration quotes identifiers and literals separately, validates the
PostgreSQL byte limit and UTF-8 round trip, and encodes coordinate separators
in its operation ID so dotted physical names cannot collide. Names are
configuration, never query parameters. The function takes an optional text
cursor and returns at most 100 distinct IDs in bytewise (`C`) order, in one
text column only. Resume after the last ID until a page is empty; discovery
does not freeze concurrent writes. Its body qualifies the table and builtin cast,
fixes the search path and enables row security for its own duration.

The owner policy checks `CURRENT_USER` as well as its role, so inheriting that
role does not silently broaden an application's ordinary reads. Installation
also refuses caller membership in the owner, caller schema CREATE, superuser
or BYPASSRLS roles, and applicable restrictive read policies that would defeat
the owner's permissive listing policy. Owner and caller must already exist;
the deployment owns role provisioning. Prechecks require the executing migrator
to be able to SET ROLE to the owner (`pg_has_role` with `SET`). An ordinary
migrator needs that membership provisioned before applying the operation.
The owner receives SELECT on the tenant column only, plus schema usage. It can be the table owner under FORCE, but a
dedicated NOLOGIN role need not receive payload access at all.

CREATE, owner assignment, PUBLIC revocation and the narrow EXECUTE grant run in
Prisma's migration transaction. CREATE never replaces an existing object.
Postchecks compare the function body, signature, settings, policy and ACL,
including grant options; a wider default grant fails closed instead of being
silently inherited. The checks also guard Prisma's postcheck-before-precheck
skip behavior. The table's existing RLS and FORCE settings are not changed.

Unit specs pin declaration validation and the query boundary. Real PostgreSQL
proofs live in `examples/order-infrastructure/src/tenant-listing.spec.ts`:
bounded cursor discovery, ordinary-role installation, forced-owner reads,
payload isolation, public denial, temporary-table shadowing,
and rejection of widened grants or restrictive policies. Each fixture owns
unique schema and role names on the shared database; nothing alters the
application's production tables or starts another server.

**No pool or timeout options** (issue #497). Each one is already expressible
below the starter, and a second spelling would have to agree with the first:
the timeouts are URL query parameters the `pg` driver sends at startup
(`pg-connection-string` copies every parameter, `Client.getStartupConf` sends
the three timeouts) or an `ALTER ROLE … SET`, and the pool size is a `pg.Pool`
the application builds in its `client` arrow and hands Prisma as `pg`. That
pool still ends with the scope — `release` is `runtime().close()`, which is the
driver's `pool.end()` whoever built the pool, unlike Prisma's own `db.close()`.
If a release ever switches to `db.close()`, a handed-in pool leaks.

**No `CONCURRENTLY` step** (issue #506). The runner wraps a migration in one
transaction; a non-transactional step is Prisma's to add. The documented
out-of-band procedure leans on two measured runner facts — the postcheck is
tested before the precheck and skips a pre-satisfied operation, and
`createIndex`'s check is `to_regclass(…) IS NOT NULL`, by name only — which is
why it insists on `pg_index.indisvalid`.

**No read-only `tenantPinned`** (issue #499). Prisma 8's `transaction` takes
no options at all, so there is no `READ ONLY` to open, and what is left — the
three `SqlError` arms folded into the defect channel — is one `mapErrCases` an
adapter writes once, as `examples/order-infrastructure`'s `pinnedOrDefect`
does. A variant here would be that line under a second name.
