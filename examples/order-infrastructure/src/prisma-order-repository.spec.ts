import { Module, type ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/start-example-order-application";
import { placeOrder } from "@btravstack/start-example-order-domain";
import { describe, expect, test } from "vitest";

import { openDatabase, PersistenceModule, prismaOrderRepository } from "./index.js";

const it = test.extend<{ repository: ServiceOf<OrderRepository> }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; the repository depends on no other fixture
  repository: async ({}, use) => {
    const db = await openDatabase();
    await use(prismaOrderRepository(db));
    await db.$disconnect();
  },
});

const order = (id: string, quantity: number) => placeOrder(id, quantity).getOrThrow();

describe("the Prisma OrderRepository", () => {
  it("round-trips a saved order through the database", async ({ repository }) => {
    await expect(repository.save(order("o-1", 3))).toBeOkWith({ id: "o-1", quantity: 3 });
    await expect(repository.find("o-1")).toBeOkWith({ id: "o-1", quantity: 3 });
  });

  // The load-bearing assertion: the UNIQUE index on `Order.orderId` raises a
  // real P2002, `@unthrown/prisma` hands it over as `UniqueConstraintViolation`,
  // and what leaves the adapter is the application's own `DuplicateOrder`.
  it("translates a real unique-constraint violation into DuplicateOrder", async ({
    repository,
  }) => {
    await expect(repository.save(order("o-1", 1))).toBeOk();

    const duplicate = await repository.save(order("o-1", 2));

    expect(duplicate).toBeErrTagged("DuplicateOrder", { id: "o-1" });
    expect(duplicate).not.toBeErrTagged("UniqueConstraintViolation");
  });

  it("returns the domain's OrderNotFound for an unknown id", async ({ repository }) => {
    await expect(repository.find("missing")).toBeErrTagged("OrderNotFound", { id: "missing" });
  });
});

describe("the read path's error channel", () => {
  // Absence is the only thing `find` reports as an error. A row that cannot
  // become an `Order` — here, a quantity the entity's invariant rejects,
  // written straight past Prisma — is an unmodelled failure, so it arrives as a
  // defect rather than widening `E` with infrastructure vocabulary.
  it("surfaces a corrupt row as a defect, not as an error", async () => {
    const db = await openDatabase();
    await db.$executeRawUnsafe(
      `INSERT INTO "Order" ("orderId", "quantity") VALUES ('o-corrupt', 0)`,
    );

    await expect(prismaOrderRepository(db).find("o-corrupt")).toBeDefect();

    await db.$disconnect();
  });
});

describe("PersistenceModule", () => {
  it("satisfies the application's OrderRepository need inside a scope", async () => {
    const result = await Module.scoped(PersistenceModule, (ctx) => {
      const repository = ctx.get(OrderRepository);
      return repository.save(order("o-1", 5)).flatMap(() => repository.find("o-1"));
    });

    expect(result).toBeOkWith({ id: "o-1", quantity: 5 });
  });

  // Teardown reaching a real resource: the client the scope acquired is
  // disconnected on close, so the same repository can no longer query.
  it("disconnects the Prisma client when the scope closes", async () => {
    let escaped: ServiceOf<OrderRepository> | undefined;

    const result = await Module.scoped(PersistenceModule, (ctx) => {
      escaped = ctx.get(OrderRepository);
      return escaped.save(order("o-1", 1));
    });

    expect(result).toBeOk();
    await expect(escaped?.find("o-1")).toBeDefect();
  });
});
