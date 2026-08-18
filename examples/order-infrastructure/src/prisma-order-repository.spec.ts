import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { OrderRepository } from "@btravstack/example-order-application";
import { fromSafePromise } from "unthrown";
import { describe, expect, inject, vi } from "vitest";

import { OrderPersistenceModule } from "./index.js";
import { it } from "./test-fixtures.js";

/**
 * The persistence module plus the one thing only the kernel would otherwise
 * provide: the environment `databaseConfig` binds `DATABASE_URL` from. A
 * deployment gets it from `start`; a `Module.scoped` test has to say it.
 */
const scopedPersistence = (applicationName?: string) =>
  Module("ScopedPersistence")({
    imports: [OrderPersistenceModule],
    provides: [
      Provider(Env)({
        value: {
          DATABASE_URL:
            applicationName === undefined
              ? inject("__ORDERS_DATABASE_URL__")
              : // libpq honours `application_name` in the URL and PostgreSQL
                // reports it on every backend, which is what lets the pool
                // spec below count ITS OWN connections on a server every other
                // workspace's tests are using at the same time.
                `${inject("__ORDERS_DATABASE_URL__")}?application_name=${applicationName}`,
        },
      }),
    ],
    exports: [OrderRepository],
  });

describe("the Prisma OrderRepository", () => {
  it("hands back the entity it saved", async ({ tenant, repository, anOrder }) => {
    // GIVEN this test's own tenant
    // WHEN an order is saved under it
    // THEN the write answers with the entity itself
    await expect(repository.save(tenant, anOrder("o-1", 3))).toBeOkWith({
      id: "o-1",
      quantity: 3,
    });
  });

  it("reads a saved order back as the same entity", async ({ tenant, repository, anOrder }) => {
    // GIVEN an order saved under this test's tenant
    // WHEN it is read back — chained, so the write's own `Result` is consumed
    // and a failed write cannot be mistaken for a failed read
    const roundTripped = await repository
      .save(tenant, anOrder("o-1", 3))
      .flatMap(() => repository.find(tenant, "o-1"));

    // THEN the round trip is lossless
    expect(roundTripped).toBeOkWith({ id: "o-1", quantity: 3 });
  });

  it("deletes the one row the unique key names", async ({ tenant, repository, anOrder }) => {
    // GIVEN a stored order
    // WHEN it is removed and then looked for — chained, so a failed removal
    // cannot be mistaken for a successful one
    const afterRemoval = await repository
      .save(tenant, anOrder("o-1", 3))
      .flatMap(() => repository.remove(tenant, "o-1"))
      .flatMap(() => repository.find(tenant, "o-1"));

    // THEN it is gone: `(tenantId, orderId)` carries the UNIQUE index, so this
    // is a single-row `delete`, not a batch whose count has to be interpreted
    expect(afterRemoval).toBeErrTagged("OrderNotFound", { id: "o-1" });
  });

  it("answers OrderNotFound when there is nothing to remove", async ({ tenant, repository }) => {
    // GIVEN a tenant with nothing in it
    // WHEN a placement that never landed is compensated — what a re-run of the
    // saga's `cancelPlacement` does
    const removal = await repository.remove(tenant, "o-absent");

    // THEN Prisma's P2025 arrives as the domain's own value, so the
    // compensation can ignore it on purpose rather than crash on a throw
    expect(removal).toBeErrTagged("OrderNotFound", { id: "o-absent" });
  });

  it("translates a real unique-constraint violation into DuplicateOrder", async ({
    tenant,
    repository,
    anOrder,
  }) => {
    // GIVEN an order already stored in this tenant
    // WHEN the same id is saved again, in the same tenant
    const duplicate = await repository
      .save(tenant, anOrder("o-1", 1))
      .flatMap(() => repository.save(tenant, anOrder("o-1", 2)));

    // THEN the load-bearing assertion: the UNIQUE index on
    // `Order(tenantId, orderId)` raises a real P2002, `@unthrown/prisma` hands
    // it over as `UniqueConstraintViolation`, and what leaves the adapter is
    // the application's own `DuplicateOrder` — a single `_tag`, so asserting
    // it is also the assertion that the infrastructure tag did not escape.
    expect(duplicate).toBeErrTagged("DuplicateOrder", { id: "o-1" });
  });

  it("returns the domain's OrderNotFound for an unknown id", async ({ tenant, repository }) => {
    // GIVEN a tenant with nothing in it
    // WHEN an unknown id is looked up
    // THEN absence is the one thing `find` reports as an error
    await expect(repository.find(tenant, "missing")).toBeErrTagged("OrderNotFound", {
      id: "missing",
    });
  });
});

describe("tenancy", () => {
  it("lets two tenants hold the same order id without either seeing the other", async ({
    tenant,
    repository,
    anOrder,
  }) => {
    // GIVEN the same order id placed by two different tenants — which the
    // composite unique key permits and a single-tenant schema would not
    const other = `${tenant}-other`;
    const seen = await repository
      .save(tenant, anOrder("o-shared", 3))
      .flatMap(() => repository.save(other, anOrder("o-shared", 7)))
      .flatMap(() => repository.find(tenant, "o-shared"));

    // WHEN the first tenant reads that id back
    // THEN the read is scoped to the tenant the CALLER named: the first
    // tenant's quantity, never the second's, and never a duplicate at the write
    expect(seen).toBeOkWith({ id: "o-shared", quantity: 3 });
  });

  it("hides another tenant's order entirely, rather than merely reading past it", async ({
    tenant,
    repository,
    anOrder,
  }) => {
    // GIVEN an order that belongs to somebody else
    const seen = await repository
      .save(`${tenant}-other`, anOrder("o-theirs", 3))
      .flatMap(() => repository.find(tenant, "o-theirs"));

    // WHEN this tenant looks for it
    // THEN it does not exist as far as this tenant is concerned
    expect(seen).toBeErrTagged("OrderNotFound", { id: "o-theirs" });
  });
});

describe("the read path's error channel", () => {
  it("surfaces a corrupt row as a defect, not as an error", async ({ db, tenant, repository }) => {
    // GIVEN a row written straight past Prisma into this test's tenant,
    // carrying a quantity the entity's invariant rejects
    await db.$executeRawUnsafe(
      `INSERT INTO "Order" ("tenantId", "orderId", "quantity") VALUES ($1, 'o-corrupt', 0)`,
      tenant,
    );

    // WHEN it is read back
    const corrupt = await repository.find(tenant, "o-corrupt");

    // THEN it is an unmodelled failure, so it arrives as a defect carrying the
    // entity's own rejection rather than widening `E` with infrastructure
    // vocabulary
    expect(corrupt).toBeDefectWith(expect.objectContaining({ _tag: "InvalidEntity" }));
  });
});

describe("OrderPersistenceModule", () => {
  it("satisfies the application's OrderRepository need inside a scope", async ({
    tenant,
    anOrder,
  }) => {
    // GIVEN the module the composition root imports, plus the environment the
    // kernel would otherwise provide
    // WHEN a scope is opened over it and both operations run under a tenant
    const result = await Module.scoped(scopedPersistence(), (ctx) => {
      const repository = ctx.get(OrderRepository);
      return repository
        .save(tenant, anOrder("o-1", 5))
        .flatMap(() => repository.find(tenant, "o-1"));
    });

    // THEN the port resolves to a working repository
    expect(result).toBeOkWith({ id: "o-1", quantity: 5 });
  });

  it("ends the connection pool when the scope closes", async ({ db, tenant, anOrder }) => {
    // GIVEN a scope whose connections carry a name no other test uses, so they
    // can be counted on a server the whole repository shares
    const applicationName = `pool-${tenant}`;
    const backends = async (): Promise<number> => {
      const rows = await db.$queryRawUnsafe<readonly { readonly n: number }[]>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        applicationName,
      );
      return rows[0]?.n ?? 0;
    };

    // WHEN the scope acquires the database, writes through it, and closes
    let duringScope = 0;
    await Module.scoped(scopedPersistence(applicationName), (ctx) =>
      ctx
        .get(OrderRepository)
        .save(tenant, anOrder("o-1", 1))
        .flatMap(() => fromSafePromise(backends().then((n) => (duringScope = n)))),
    );
    // Synchronising, not asserting: PostgreSQL retires a backend a moment
    // after the client hangs up.
    await vi.waitUntil(async () => (await backends()) === 0, { timeout: 5_000 });

    // THEN teardown reached a real resource: the pool the scope acquired was
    // open while it ran and is gone now. Not asserted by querying through the
    // released client — Prisma reconnects lazily, so that would only prove the
    // client still works, which it does.
    expect({ openedDuringScope: duringScope > 0, remaining: await backends() }).toEqual({
      openedDuringScope: true,
      remaining: 0,
    });
  });
});
