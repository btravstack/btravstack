# `@btravstack/core` example: the order infrastructure layer

The adapter side. This layer speaks Prisma, PostgreSQL and SQLSTATEs, and its
job is to make sure none of that vocabulary reaches the layers above it.

```text
src/prisma/contract.prisma         the Order, Customer and OutboxMessage models, and Order's RLS policy
prisma/migrations/                 planned from the contract, committed, applied by db:migrate
prisma/migrations/app/refs/db.json the contract hash a dev database is at — what `migration plan` diffs from
src/database.ts                    the client, the OrderDatabase port, the acquire/release provider
src/prisma-order-repository.ts     the adapter — where Prisma's errors become the domain's
src/prisma-customer-repository.ts  the customers vertical's adapter — read-only, because its port is
src/prisma-outbox.ts               the outbox's read side, for whichever deployment relays it
src/module.ts                      OrderTenantPersistence, OrderPersistenceModule, CustomerPersistenceModule
src/__tests__/test-fixtures.ts               the in-memory database and the repositories, as Vitest fixtures
```

## The schema is migrated, not hand-created

`prisma/migrations/` is planned by `prisma migration plan` from
`src/prisma/contract.prisma` and committed — one source of truth for the shape.
**The row-security policy is in the contract too**, as `@@rls` on `Order` plus
a `policy_all` block, so the planner emits `ENABLE ROW LEVEL SECURITY` and
`CREATE POLICY` like any other operation; under Prisma 7 that migration was
hand-written and a regeneration could silently drop it. `schema-drift.spec.ts`
still asserts the policy is there, because a contract edit that drops `@@rls`
would plan its removal just as quietly.

A deployment with a durable database runs them **before the process starts**:

```bash
# the OWNER's credentials — this creates and alters. The application must NOT
# connect this way: Prisma 8 emits `ENABLE ROW LEVEL SECURITY` and cannot say
# `FORCE`, so the owner bypasses every policy.
DATABASE_URL="postgres://owner:secret@localhost:5432/orders" \
  pnpm --filter @btravstack/example-order-infrastructure db:migrate
# or, from the root, for every workspace that has migrations:
pnpm turbo run db:migrate
```

`turbo.json` makes `dev` depend on `^db:migrate`, so the app cannot start
against an unmigrated database. The application never migrates itself at boot —
that belongs to the deploy step, not the process.

### Authoring one: plan, review, apply, and move the ref

```bash
cd examples/order-infrastructure   # the paths below are relative to it
pnpm exec prisma migration plan --name add_note
# review prisma/migrations/app/<timestamp>_add_note/, then:
DATABASE_URL="postgres://owner:secret@localhost:5432/orders" pnpm db:migrate:dev
git add prisma/migrations
```

**The last step is not optional, and `db:migrate` is not a substitute for
`db:migrate:dev` here.** `migration plan` diffs the contract against an
_origin_, and with no `--from` that origin is the **`db` ref** —
`prisma/migrations/app/refs/db.json`, a committed file naming the contract hash
the dev database has been brought to. `db migrate --advance-ref db` is the only
apply-time command that moves it.

Skip it and the ref stays at the previous head, so the _next_ plan diffs from
there and re-includes the migration you already shipped. Measured on this
example: with the ref left behind, a second plan came out at **2 operations**
instead of 1, redoing the first change — and a migration like that cannot apply
to a database that already has it (`MIGRATION.PATH_UNREACHABLE`).

With **no** ref at all it is louder rather than quieter: `migration plan`
refuses with `MIGRATION.PLAN_ORIGIN_UNKNOWN` rather than writing a
recreate-everything package. That is why the ref is committed — the first
contract change after this one would otherwise stop there.

**A deployment runs plain `db:migrate`**, without `--advance-ref`: the ref is a
file in the repository describing a _development_ database, and a release
running from a built artifact has no business writing one. For the same reason
neither the test setup nor `pnpm dev` advances it — both apply migrations to a
throwaway container, and a `pnpm test` that mutates a tracked file would be a
worse bug than the one it prevented.

The suites do the same rather than something of their own: `src/global-setup.ts`
runs **`prisma db migrate`** — that very command — against the shared test
server, once per run, under a cross-process lock so two workspaces cannot race
to be first. The marker in `prisma_contract.marker` is what makes running it
again a no-op. `schema-drift.spec.ts` pins that the migrations were replanned
after a contract change.

Migrating and running are two different roles. `db migrate` connects as the
database **owner**, because it creates and alters; the application connects as
`orders_app`, which owns nothing and is `NOSUPERUSER NOBYPASSRLS` — a superuser
or a `BYPASSRLS` role bypasses row security whatever the tables themselves say,
and a table's **owner** bypasses it too unless the table is `FORCE`d, which is
the line the migration adds. So the role a spec runs under is what decides
whether a policy can be tested at all.
`internal/test-infra` provisions that role after every migration, and
`DATABASE_URL` — still the one variable — is what carries it.

This used to be SQLite held _in memory_, born empty inside `openDatabase` with
the committed SQL replayed statement by statement, because no external command
could reach a database that dies with the process. A shared PostgreSQL both
removes that hand-rolled runner and lets the tests run the real one.

The migration connection lives in `prisma.config.ts`, not the contract: it is
the CLI's alone, while the application reads its own `DATABASE_URL` through
`@btravstack/prisma`.

## The translation is the point

`@btravstack/prisma/result`'s `tryQuery` gives a write an error channel of
exactly the outcomes a caller might branch on, keyed on PostgreSQL's own
SQLSTATE — `UniqueConstraintViolation` (`23505`), `ForeignKeyViolation`
(`23503`), `NotAuthorized` (`42501`). The port above promises
`AsyncResult<Order, DuplicateOrder>` and nothing else, so every one of those
three has to be dealt with here:

```ts
// `tenantId` is the adapter's own, closed over at construction — the policy's
// `WITH CHECK` refuses a row that names another.
tryQuery(() =>
  db.orm.orders.Order.create({ tenantId, orderId: order.id, quantity: order.quantity }),
)
  .mapErrCases((matcher, defect) =>
    matcher
      .with(
        P.tag("UniqueConstraintViolation"),
        () => new DuplicateOrder({ id: order.id }),
      )
      .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
      .with(P.tag("NotAuthorized"), (refused) => defect(refused)),
  )
  .map(() => order);
```

Every case is named. There is no `P._` to hide behind — this repo bans it — and
`mapErrCases` has no `.otherwise()` either, so the compiler names any case left
uncovered. Only the duplicate has a meaning the application shares; a foreign
key is a relation this schema does not have, and `NotAuthorized` is the
row-security policy refusing a write — which an adapter that closes over one
tenant and writes that tenant's column cannot legitimately provoke. Reaching
either means the code is wrong, not the request. That is the defect channel,
not `E`.

Try to pass a database error through untranslated and it does not compile:

```text
Type 'AsyncResult<Order, UniqueConstraintViolation>' is not assignable to
type 'AsyncResult<Order, DuplicateOrder>'.
```

Add a fourth SQLSTATE upstream and this file breaks — and only this file.

## The read path carries no infrastructure error at all

A read answers `null` for a miss rather than failing, and a database that will
not answer is a defect. `find` therefore adds the one error the domain does
model:

```ts
tryQuery(() => db.orm.orders.Order.where({ tenantId, orderId: id }).first())
  .flatMap((row) =>
    row === null ? Err(new OrderNotFound({ id })) : hydrate(row),
  );
```

`hydrate` runs the entity's invariants again, so a stored row that could never
have been a valid `Order` — someone else's `INSERT`, a bad migration — becomes a
defect rather than widening `E`. The spec writes such a row with raw SQL and
asserts the defect.

`prisma-customer-repository.ts` is the same file one procedure long, and it is
the whole customers vertical's outermost layer: a `first()` read, `null` into
`CustomerNotFound`, and a `hydrate` that rebuilds the branded `Customer`. It has
no write path because its port has none — this application registers nobody, and
inventing an adapter method the use cases never call would be infrastructure the
domain did not ask for.

## A real database, shared, and a tenant per test

The specs run against a real PostgreSQL, so the duplicate above is a genuine
`23505` raised by a genuine UNIQUE index, not a stub returning a canned error.
It is **one** server for the whole repository — the same one Temporal's own
persistence lives on, a database each — started by
[`internal/test-infra`](../../internal/test-infra/README.md) and migrated once
per run by `src/global-setup.ts` with `prisma db migrate`, the command a
deployment runs — as the owner, after which the specs connect as the
non-superuser `orders_app` for the reason above.

Nothing is truncated or dropped between tests, because nothing needs to be:
**every table carries `tenantId`** as the leading column of its identity
constraint, and each test declares a tenant of its own (a UUID). That is what
makes a shared database cost one migration for the whole gate rather than one
per test — the reason this stopped being SQLite in memory, where every test
built its own schema.

The tenancy is **explicit**, and it is the ADAPTER that is handed the tenant
rather than every call:

```ts
export const prismaOrderRepository = (
  db: OrderDatabaseClient,
  tenantId: TenantId,
): ServiceOf<OrderRepository> => ({ ... });
```

`OrderTenantPersistence` is that binding as a module, and it is composed inside
a **unit** — a request's, an activity attempt's, a delivery's — where `Tenant`
has already been provided from whatever opened it. Every statement closes over
the tenant, so the port has no parameter a caller could name another one in.

And the database enforces it rather than trusting it: every method runs inside
`tenantPinned(db, tenantId, work)` — `@btravstack/prisma/rls`, which opens a
transaction and pins `set_config('app.tenant_id', …)` on its connection — and
`Order` carries a `policy_all` block in the contract reading that same setting.
So `list` names no tenant in its `where` at all; the policy is what narrows it,
and `src/rls.spec.ts` is what proves that against the real server rather than
against a filter.

The pin is a **transaction** rather than a wrapped client because
`set_config(…, true)` is transaction-local: a session-scoped pin only works
while the pool happens to hand back the same connection. And the specs connect
as a non-owner because Prisma 8 emits `ENABLE ROW LEVEL SECURITY` with no way
to say `FORCE`, so the table's owner would bypass the policy entirely —
`rls.spec.ts` carries that as a standing assertion.
`TenantId` is still the domain's own branded string, which is what keeps the
one place a tenant is claimed — `prisma-outbox.ts`, where a row becomes an
`OrderEvent` — honest.

**Two tables are deliberately not policed, and specs are what guard them.**
`Customer` stays on the raw client because the `customers` procedures are
unmarked: a request under them forks `anonymous`, which has no principal to take
a tenant from, so the caller names it on the input and the adapter filters by
hand. `OutboxMessage` stays there because the relay reads it **across** tenants,
from outside any unit, so there is no tenant to pin it to. What holds those two
hand filters honest is
`src/prisma-customer-repository.spec.ts`'s "does not read another tenant's
customer" and `src/prisma-outbox.spec.ts`'s "does not hand one tenant another's
pending events" — **two specs, not the database**. A bug in either filter is
caught by a test run; on `Order` it is refused by PostgreSQL.

That is the application's design, not the framework's — no starter has a
tenancy concept, and none should, because what establishes a tenant is a
decision about a specific system. And a spec needs no machinery either: the
fixture builds `prismaOrderRepository(db, tenant)`, a second one over another
tenant is what a cross-tenant spec asserts across, and nothing cleans up.

The emitted contract (`contract.json`, `contract.d.ts`) is gitignored and minted
by turbo's own `generate` task —
which `test` and `typecheck` both depend on, so one generator runs,
ordered by the task graph. The scripts themselves do not call
`prisma contract emit`: they did until a cold cache ran the task and the script's
inline copy concurrently and the two collided on `mkdir`.

Nothing to install, nothing to start.

## One persistence module per vertical, over one shared connection

```ts
export const OrderTenantPersistence = Module("OrderTenantPersistence")({
  needs: [Tenant, OrderDatabase],
  provides: [
    Provider(OrderRepository)({
      inject: { db: OrderDatabase, tenant: Tenant },
      sync: ({ db, tenant }) => prismaOrderRepository(db, tenant),
    }),
  ],
  exports: [OrderRepository],
});

export const OrderPersistenceModule = Module("OrderPersistence")({
  imports: [OrderDatabaseModule],
  provides: [outboxProvider],
  exports: [Outbox, OrderDatabaseModule],
});

export const CustomerPersistenceModule = Module("CustomerPersistence")({
  imports: [OrderDatabaseModule],
  provides: [customerRepositoryProvider],
  exports: [CustomerRepository],
});
```

`OrderTenantPersistence` **needs** the database rather than importing it: a
unit module's imports are built in the fork, so an import would open and close
a Prisma client per request. `OrderPersistenceModule` re-exports
`OrderDatabaseModule` for exactly that — the application scope holds the one
client, and the fork reads it.

There is no pinned-client port between the two, and under Prisma 7 there was:
`Db` held `tenantScoped(client, tenant)`. The pin is transaction-local now, so
it belongs to a transaction rather than to a wrapper — the repository opens one
per operation and pins it there. What is per unit is the tenant the adapter
closed over; the pool underneath is still the process's.

The outbox stays in the application scope, because the relay that sweeps it
runs outside any unit and across tenants; `CustomerPersistenceModule` stays
there too, because its port names its tenant.

One database, not two: di flattens the module tree into a `Set` keyed by
provider **reference**, so a graph holding both persistence modules holds the
one `orderDatabaseProvider` they both import. A composition root takes the
vertical it serves and the graph is closed:

```ts
const UnitModule = Module("Unit")({
  needs: [OrderDatabase, Logger],
  imports: [tenantOf(tenant), OrderTenantPersistence, OrderApplicationModule],
  exports: [PlaceOrder, FindOrder],
});
```

`OrderTenantPersistence` fills the repository hole, the tenant fills the
`Tenant` one, and `Logger` and the database come from the application scope the
unit is forked over — where `observability()` and `OrderPersistenceModule` are.
Neither layer knows the other exists. A root that also serves customers imports
`CustomerApplicationModule` and `CustomerPersistenceModule` next to them; one
that never does — both workers — carries neither.

The database provider takes di's `acquire`/`release` arm, so every module that
imports `OrderDatabaseModule` carries a `Scope` need that only `Module.scoped` discharges — forgetting the scope is a
compile error, and closing it disconnects a real client. The spec proves that by
holding on to the repository past the end of the scope and watching the next
query come back as a defect.

## Running it

```bash
pnpm --filter @btravstack/example-order-infrastructure test
```
