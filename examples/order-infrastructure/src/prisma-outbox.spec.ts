import { P } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("the transactional outbox", () => {
  it("appends an event in the same write as the order", async ({ repository, outbox, anOrder }) => {
    // GIVEN a fresh database
    // WHEN an order is saved
    const events = await repository.save(anOrder("o-1", 3)).flatMap(() => outbox.pending(10));

    // THEN the fact of the write is already in the outbox — no second call,
    // no second chance to forget
    expect(events).toBeOkWith([expect.objectContaining({ orderId: "o-1", quantity: 3 })]);
  });

  it("leaves no event behind when the write rolls back", async ({
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN an order already stored
    // WHEN the same id is saved again — a real UNIQUE violation, and the
    // transaction it happened in rolls back
    const events = await repository
      .save(anOrder("o-1", 1))
      .flatMap(() => repository.save(anOrder("o-1", 2)))
      .recoverErrCases((matcher) => matcher.with(P.tag("DuplicateOrder"), () => undefined))
      .flatMap(() => outbox.pending(10));

    // THEN only the first placement's event exists — the duplicate's outbox
    // row rolled back with its order row
    expect(events).toBeOkWith([expect.objectContaining({ orderId: "o-1", quantity: 1 })]);
  });

  it("marks published events so the relay never re-reads them", async ({
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN two placed orders and their pending events
    const pending = (
      await repository
        .save(anOrder("o-1", 1))
        .flatMap(() => repository.save(anOrder("o-2", 2)))
        .flatMap(() => outbox.pending(10))
    ).getOrThrow();

    // WHEN the first is marked published
    const first = pending[0];
    // oxlint-disable-next-line unthrown/no-throw -- a missing row here is a broken GIVEN, and the loudest possible answer is the right one
    if (first === undefined) throw new Error("expected a pending event");
    const rest = await outbox.markPublished([first.id]).flatMap(() => outbox.pending(10));

    // THEN only the second remains pending
    expect(rest).toBeOkWith([expect.objectContaining({ orderId: "o-2" })]);
  });
});
