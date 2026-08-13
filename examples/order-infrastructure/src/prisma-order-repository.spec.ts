import { Module, type ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/start-example-order-application";
import { describe, expect } from "vitest";

import { PersistenceModule } from "./index.js";
import { it } from "./test-fixtures.js";

describe("the Prisma OrderRepository", () => {
  it("hands back the entity it saved", async ({ repository, anOrder }) => {
    // GIVEN a fresh database
    // WHEN an order is saved
    // THEN the write answers with the entity itself
    await expect(repository.save(anOrder("o-1", 3))).toBeOkWith({ id: "o-1", quantity: 3 });
  });

  it("reads a saved order back as the same entity", async ({ repository, anOrder }) => {
    // GIVEN an order saved into a fresh database
    // WHEN it is read back — chained, so the write's own `Result` is consumed
    // and a failed write cannot be mistaken for a failed read
    const roundTripped = await repository
      .save(anOrder("o-1", 3))
      .flatMap(() => repository.find("o-1"));

    // THEN the round trip is lossless
    expect(roundTripped).toBeOkWith({ id: "o-1", quantity: 3 });
  });

  it("deletes the one row the unique key names", async ({ repository, anOrder }) => {
    // GIVEN a stored order
    // WHEN it is removed and then looked for — chained, so a failed removal
    // cannot be mistaken for a successful one
    const afterRemoval = await repository
      .save(anOrder("o-1", 3))
      .flatMap(() => repository.remove("o-1"))
      .flatMap(() => repository.find("o-1"));

    // THEN it is gone: `orderId` carries the UNIQUE index, so this is a
    // single-row `delete`, not a batch whose count has to be interpreted
    expect(afterRemoval).toBeErrTagged("OrderNotFound", { id: "o-1" });
  });

  it("answers OrderNotFound when there is nothing to remove", async ({ repository }) => {
    // GIVEN a fresh database
    // WHEN a placement that never landed is compensated — what a re-run of the
    // saga's `cancelPlacement` does
    const removal = await repository.remove("o-absent");

    // THEN Prisma's P2025 arrives as the domain's own value, so the
    // compensation can ignore it on purpose rather than crash on a throw
    expect(removal).toBeErrTagged("OrderNotFound", { id: "o-absent" });
  });

  it("translates a real unique-constraint violation into DuplicateOrder", async ({
    repository,
    anOrder,
  }) => {
    // GIVEN an order already stored
    // WHEN the same id is saved again
    const duplicate = await repository
      .save(anOrder("o-1", 1))
      .flatMap(() => repository.save(anOrder("o-1", 2)));

    // THEN the load-bearing assertion: the UNIQUE index on `Order.orderId`
    // raises a real P2002, `@unthrown/prisma` hands it over as
    // `UniqueConstraintViolation`, and what leaves the adapter is the
    // application's own `DuplicateOrder` — a single `_tag`, so asserting it is
    // also the assertion that the infrastructure tag did not escape.
    expect(duplicate).toBeErrTagged("DuplicateOrder", { id: "o-1" });
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

    // WHEN the scope closes and the same repository is asked to query again.
    // One chain, so the scope's own `Result` is consumed rather than dropped
    // and a failure inside it reaches the assertion instead of skipping it.
    const afterClose = await Module.scoped(PersistenceModule, (ctx) => {
      escaped = ctx.get(OrderRepository);
      return escaped.save(anOrder("o-1", 1));
    }).flatMap(() => escaped.find("o-1"));

    // THEN teardown reached a real resource: the client it acquired is
    // disconnected, so the same repository can no longer query
    expect(afterClose).toBeDefectWith(expect.any(Error));
  });
});
