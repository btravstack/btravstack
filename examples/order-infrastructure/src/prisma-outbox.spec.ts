import { P } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("the transactional outbox", () => {
  it("appends an event in the same write as the order", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN a tenant with nothing in it
    // WHEN an order is saved
    const events = await repository
      .save(tenant, anOrder("o-1", 3))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN the fact of the write is already in the outbox — no second call,
    // no second chance to forget — carrying a payload, which is what makes it
    // a create-or-replace for its subject
    expect(events).toBeOkWith([
      expect.objectContaining({
        tenantId: tenant,
        kind: "order",
        subjectId: "o-1",
        payload: { quantity: 3 },
      }),
    ]);
  });

  it("leaves no event behind when the write rolls back", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN an order already stored
    // WHEN the same id is saved again — a real UNIQUE violation, and the
    // transaction it happened in rolls back
    const events = await repository
      .save(tenant, anOrder("o-1", 1))
      .flatMap(() => repository.save(tenant, anOrder("o-1", 2)))
      .recoverErrCases((matcher) => matcher.with(P.tag("DuplicateOrder"), () => undefined))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN only the first placement's event exists — the duplicate's outbox
    // row rolled back with its order row
    expect(events).toBeOkWith([
      expect.objectContaining({ subjectId: "o-1", payload: { quantity: 1 } }),
    ]);
  });

  it("marks published events so the relay never re-reads them", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN two placed orders and their pending events
    const pending = (
      await repository
        .save(tenant, anOrder("o-1", 1))
        .flatMap(() => repository.save(tenant, anOrder("o-2", 2)))
        .flatMap(() => outbox.pending(tenant, 10))
    ).getOrThrow();

    // WHEN the first is marked published
    const first = pending[0];
    // oxlint-disable-next-line unthrown/no-throw -- a missing row here is a broken GIVEN, and the loudest possible answer is the right one
    if (first === undefined) throw new Error("expected a pending event");
    const rest = await outbox.markPublished([first.id]).flatMap(() => outbox.pending(tenant, 10));

    // THEN only the second remains pending
    expect(rest).toBeOkWith([expect.objectContaining({ subjectId: "o-2" })]);
  });

  it("appends a tombstone when the order is removed", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN a placed order
    // WHEN it is removed
    const events = await repository
      .save(tenant, anOrder("o-1", 3))
      .flatMap(() => repository.remove(tenant, "o-1"))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN the log carries both words about the subject, in order: what it
    // was, then that it is gone. A null payload IS the deletion — a reader
    // that keeps its own copy drops it here, and needs no second event type
    expect(events).toBeOkWith([
      expect.objectContaining({ subjectId: "o-1", payload: { quantity: 3 } }),
      expect.objectContaining({ subjectId: "o-1", payload: null }),
    ]);
  });

  it("appends no tombstone when there was nothing to remove", async ({
    tenant,
    repository,
    outbox,
  }) => {
    // GIVEN a tenant with nothing in it
    // WHEN a placement that never landed is compensated — a re-run of the
    // saga's `cancelPlacement`
    const events = await repository
      .remove(tenant, "o-absent")
      .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN nothing was announced: the delete failed inside the transaction, so
    // the tombstone rolled back with it. A compensation that ran twice cannot
    // tell the world twice.
    expect(events).toBeOkWith([]);
  });

  it("does not hand one tenant another's pending events", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN a write committed by somebody else
    const events = await repository
      .save(`${tenant}-other`, anOrder("o-theirs", 1))
      .flatMap(() => outbox.pending(tenant, 10));

    // WHEN this tenant's relay sweeps
    // THEN it has nothing to publish: the sweep is scoped by the tenant the
    // relay was configured with, which is what stops one deployment
    // broadcasting another's facts off a shared database
    expect(events).toBeOkWith([]);
  });
});
