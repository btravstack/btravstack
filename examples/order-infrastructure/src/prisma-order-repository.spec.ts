import { Module, type ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/start-example-order-application";
import { describe, expect } from "vitest";

import { PersistenceModule } from "./index.js";
import { it } from "./test-fixtures.js";

describe("the Prisma OrderRepository", () => {
  it("round-trips a saved order through the database", async ({ repository, anOrder }) => {
    // GIVEN a fresh database
    // WHEN an order is saved
    await expect(repository.save(anOrder("o-1", 3))).toBeOkWith({ id: "o-1", quantity: 3 });

    // THEN it reads back as the same entity
    await expect(repository.find("o-1")).toBeOkWith({ id: "o-1", quantity: 3 });
  });

  it("translates a real unique-constraint violation into DuplicateOrder", async ({
    repository,
    anOrder,
  }) => {
    // GIVEN an order already stored
    await expect(repository.save(anOrder("o-1", 1))).toBeOk();

    // WHEN the same id is saved again
    const duplicate = await repository.save(anOrder("o-1", 2));

    // THEN the load-bearing assertion: the UNIQUE index on `Order.orderId`
    // raises a real P2002, `@unthrown/prisma` hands it over as
    // `UniqueConstraintViolation`, and what leaves the adapter is the
    // application's own `DuplicateOrder`.
    expect(duplicate).toBeErrTagged("DuplicateOrder", { id: "o-1" });
    expect(duplicate).not.toBeErrTagged("UniqueConstraintViolation");
  });

  it("returns the domain's OrderNotFound for an unknown id", async ({ repository }) => {
    // GIVEN an empty database
    // WHEN an unknown id is looked up
    // THEN absence is the one thing `find` reports as an error
    await expect(repository.find("missing")).toBeErrTagged("OrderNotFound", { id: "missing" });
  });
});

describe("the read path's error channel", () => {
  it("surfaces a corrupt row as a defect, not as an error", async ({ db, repository }) => {
    // GIVEN a row written straight past Prisma, carrying a quantity the
    // entity's invariant rejects
    await db.$executeRawUnsafe(
      `INSERT INTO "Order" ("orderId", "quantity") VALUES ('o-corrupt', 0)`,
    );

    // WHEN it is read back
    const corrupt = await repository.find("o-corrupt");

    // THEN it is an unmodelled failure, so it arrives as a defect carrying the
    // entity's own rejection rather than widening `E` with infrastructure
    // vocabulary
    expect(corrupt).toBeDefectWith(expect.objectContaining({ _tag: "InvalidEntity" }));
  });
});

describe("PersistenceModule", () => {
  it("satisfies the application's OrderRepository need inside a scope", async ({ anOrder }) => {
    // GIVEN the module the composition root imports
    // WHEN a scope is opened over it and both operations run
    const result = await Module.scoped(PersistenceModule, (ctx) => {
      const repository = ctx.get(OrderRepository);
      return repository.save(anOrder("o-1", 5)).flatMap(() => repository.find("o-1"));
    });

    // THEN the port resolves to a working repository
    expect(result).toBeOkWith({ id: "o-1", quantity: 5 });
  });

  it("disconnects the Prisma client when the scope closes", async ({ anOrder }) => {
    // GIVEN a repository smuggled out of the scope that acquired it.
    // Definite assignment, not `| undefined` plus `escaped?.`: the optional
    // call would make the assertion below tolerate a scope callback that never
    // ran, asserting against `undefined` instead of against a disconnected
    // client. Declared this way, that failure is a loud TypeError at the access.
    let escaped!: ServiceOf<OrderRepository>;

    // WHEN the scope closes
    const result = await Module.scoped(PersistenceModule, (ctx) => {
      escaped = ctx.get(OrderRepository);
      return escaped.save(anOrder("o-1", 1));
    });

    // THEN teardown reached a real resource: the client it acquired is
    // disconnected, so the same repository can no longer query
    expect(result).toBeOk();
    await expect(escaped.find("o-1")).toBeDefectWith(expect.any(Error));
  });
});
