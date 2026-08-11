# `@btravstack/start` example: the order infrastructure layer

The adapter side. This layer speaks Prisma, SQLite and P-codes, and its job is
to make sure none of that vocabulary reaches the layers above it.

```
prisma/schema.prisma            one Order model, UNIQUE on the business id
src/database.ts                 the client, the OrderDatabase port, the acquire/release provider
src/prisma-order-repository.ts  the adapter — where Prisma's errors become the domain's
src/module.ts                   PersistenceModule
src/test-fixtures.ts            the in-memory database and repository, as Vitest fixtures
```

## The translation is the point

`@unthrown/prisma` gives `tryCreate` an error channel of exactly the outcomes a
caller might branch on — `UniqueConstraintViolation` (P2002),
`ForeignKeyViolation` (P2003), `RecordNotFound` (P2025/P2018). The port above
promises `AsyncResult<Order, DuplicateOrder>` and nothing else, so every one of
those three has to be dealt with here:

```ts
db.order
  .tryCreate({ data: { orderId: order.id, quantity: order.quantity } })
  .mapErrCases((matcher, defect) =>
    matcher
      .with(
        P.tag("UniqueConstraintViolation"),
        () => new DuplicateOrder({ id: order.id }),
      )
      .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
      .with(P.tag("RecordNotFound"), (missing) => defect(missing)),
  )
  .map(() => order);
```

Every case is named. There is no `P._` to hide behind — this repo bans it — and
`mapErrCases` has no `.otherwise()` either, so the compiler names any case left
uncovered. Only the duplicate has a meaning the application shares; the other
two describe a schema this adapter does not have (there is no relation to
violate, and `create` has no row of its own to miss), so reaching them means the
code is wrong, not the request. That is the defect channel, not `E`.

Try to pass a Prisma error through untranslated and it does not compile:

```
Type 'AsyncResult<Order, UniqueConstraintViolation>' is not assignable to
type 'AsyncResult<Order, DuplicateOrder>'.
```

Add a fourth P-code upstream and this file breaks — and only this file.

## The read path carries no infrastructure error at all

`tryFindUnique` is a read, so `@unthrown/prisma` gives it `E = never`: absence
is `Ok(null)` and a database that will not answer is a defect. `find` therefore
adds the one error the domain does model:

```ts
db.order
  .tryFindUnique({ where: { orderId: id } })
  .flatMap((row) =>
    row === null ? Err(new OrderNotFound({ id })) : hydrate(row),
  );
```

`hydrate` runs the entity's invariants again, so a stored row that could never
have been a valid `Order` — someone else's `INSERT`, a bad migration — becomes a
defect rather than widening `E`. The spec writes such a row with raw SQL and
asserts the defect.

## A real database, no Docker

The specs run against real SQLite held in memory
(`@prisma/adapter-better-sqlite3`), so the duplicate above is a genuine P2002
raised by a genuine UNIQUE index, not a stub returning a canned error. The
generated client is gitignored and minted by the `test` / `typecheck` scripts:

```json
"test": "prisma generate && vitest run",
"typecheck": "prisma generate && tsc --noEmit"
```

Nothing to install, nothing to start.

## `PersistenceModule` closes the application's need

```ts
export const PersistenceModule = Module("Persistence")({
  provides: [orderDatabaseProvider, orderRepositoryProvider],
  exports: [OrderRepository],
});
```

It exports `OrderRepository` alone — the Prisma client stays behind the
boundary, so no outer module can reach it and start speaking SQL. A composition
root imports both halves and the graph is closed:

```ts
const AppModule = Module("App")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, FindOrder, Logger],
});
```

The database provider takes di's `acquire`/`release` arm, so the module carries
a `Scope` need that only `Module.scoped` discharges — forgetting the scope is a
compile error, and closing it disconnects a real client. The spec proves that by
holding on to the repository past the end of the scope and watching the next
query come back as a defect.

## Running it

```bash
pnpm --filter @btravstack/start-example-order-infrastructure test  # 6 specs
```
