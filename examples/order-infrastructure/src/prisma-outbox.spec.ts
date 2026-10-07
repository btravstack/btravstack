import { setTimeout as delay } from "node:timers/promises";

import type { DuplicateOrder } from "@btravstack/example-order-domain";
import type { OutboxMessage } from "@btravstack/outbox";
import { OkAsync, P, fromSafePromise, type AsyncResult } from "unthrown";
import { uuidv7 } from "uuidv7";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

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
      .save(anOrder("0199a1e0-0000-7000-8000-000000000001", 3))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN the fact of the write is already in the outbox — no second call,
    // no second chance to forget — carrying a payload, which is what makes it
    // a create-or-replace for its subject
    expect(events).toBeOkWith([
      expect.objectContaining({
        tenantId: tenant,
        kind: "order",
        subjectId: "0199a1e0-0000-7000-8000-000000000001",
        payload: JSON.stringify({ quantity: 3 }),
        occurredAt: expect.any(Date),
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
      .save(anOrder("0199a1e0-0000-7000-8000-000000000001", 1))
      .flatMap(() => repository.save(anOrder("0199a1e0-0000-7000-8000-000000000001", 2)))
      .recoverErrCases((matcher) => matcher.with(P.tag("DuplicateOrder"), () => undefined))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN only the first placement's event exists — the duplicate's outbox
    // row rolled back with its order row
    expect(events).toBeOkWith([
      expect.objectContaining({
        subjectId: "0199a1e0-0000-7000-8000-000000000001",
        payload: JSON.stringify({ quantity: 1 }),
      }),
    ]);
  });

  it("marks published exactly what the relay published", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN two placed orders and their pending events
    // WHEN a claim's relay publishes only the first of the batch
    const rest = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000001", 1))
      .flatMap(() => repository.save(anOrder("0199a1e0-0000-7000-8000-000000000002", 2)))
      .flatMap(() => outbox.claim(tenant, 10, ([first]) => OkAsync(first ? [first.id] : [])))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN only the second remains pending, for the next claim
    expect(rest).toBeOkWith([
      expect.objectContaining({ subjectId: "0199a1e0-0000-7000-8000-000000000002" }),
    ]);
  });

  it("marks EVERY id the relay hands back, not just the first", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN three placed orders and their three pending events
    // WHEN one claim publishes all three
    const rest = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000011", 1))
      .flatMap(() => repository.save(anOrder("0199a1e0-0000-7000-8000-000000000012", 2)))
      .flatMap(() => repository.save(anOrder("0199a1e0-0000-7000-8000-000000000013", 3)))
      .flatMap(() => outbox.claim(tenant, 10, (batch) => OkAsync(batch.map(({ id }) => id))))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN nothing is left pending. A mark that took only its first id would be
    // silent — the relay would publish the rest again on the next sweep.
    expect(rest).toBeOkWith([]);
  });

  it("marks nothing when the relay defects mid-batch", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN two placed orders
    // WHEN the claim's relay dies — the transaction the mark would have
    // committed in rolls back with it
    const rest = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000021", 1))
      .flatMap(() => repository.save(anOrder("0199a1e0-0000-7000-8000-000000000022", 2)))
      .flatMap(() =>
        outbox
          .claim(tenant, 10, () =>
            fromSafePromise(Promise.reject(new Error("the relay died"))).map((): number[] => []),
          )
          .recoverDefect(() => OkAsync(undefined)),
      )
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN both are still pending: a crash re-delivers rather than loses
    expect(rest).toBeOkWith([
      expect.objectContaining({ subjectId: "0199a1e0-0000-7000-8000-000000000021" }),
      expect.objectContaining({ subjectId: "0199a1e0-0000-7000-8000-000000000022" }),
    ]);
  });

  it("skips a tenant another relay holds, rather than handing it the same rows", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN a pending event
    const seenBySecond: (readonly OutboxMessage[])[] = [];

    // WHEN a second relay claims the tenant WHILE the first holds it — from
    // inside the first's batch, on another connection of the same pool
    const claimed = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000031", 1))
      .flatMap(() =>
        outbox.claim(tenant, 10, (batch) =>
          outbox
            .claim(tenant, 10, (second) => {
              seenBySecond.push(second);
              return OkAsync([]);
            })
            .map(() => batch.map(({ id }) => id)),
        ),
      )
      .map(() => seenBySecond);

    // THEN the second relay was never handed a batch at all
    expect(claimed).toBeOkWith([]);
  });

  it("publishes every message exactly once across four racing relays", async ({
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN 48 pending events, and a relay that claims in batches of four
    // until nothing is pending. Each batch reads the outbox once more before
    // answering, so a claim stays held across a real round trip and the four
    // relays below overlap.
    const ids = Array.from({ length: 48 }, () => uuidv7());
    const published: string[] = [];
    const relay = async (): Promise<void> => {
      while ((await outbox.pending(tenant, 1)).get().length > 0) {
        await outbox
          .claim(tenant, 4, (batch) =>
            outbox.pending(tenant, 1).map(() => {
              published.push(...batch.map(({ subjectId }) => subjectId));
              return batch.map(({ id }) => id);
            }),
          )
          .get();
      }
    };

    // WHEN four relays sweep the one tenant at once
    const swept = await ids
      .reduce<AsyncResult<void, DuplicateOrder>>(
        (chain, id) => chain.flatMap(() => repository.save(anOrder(id, 1)).map(() => undefined)),
        OkAsync(),
      )
      .flatMap(() => fromSafePromise(Promise.all([relay(), relay(), relay(), relay()])))
      .map(() => published);

    // THEN each subject went out once, and in the order it was written: the
    // claim is per tenant, so a later batch never overtakes an earlier one
    expect(swept).toBeOkWith(ids);
  });

  it("answers every tenant's oldest pending time in one call", async ({
    tenant,
    otherTenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN two pending events for this tenant and none for the other
    // WHEN the oldest pending time is asked for both
    const oldest = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000041", 1))
      .flatMap(() => repository.save(anOrder("0199a1e0-0000-7000-8000-000000000042", 1)))
      .flatMap(() => outbox.oldestPending([tenant, otherTenant]));

    // THEN only the tenant with something pending is named, once
    expect(oldest).toBeOkWith([{ tenantId: tenant, occurredAt: expect.any(Date) }]);
  });

  it("publishes what has committed, so a lower id still in flight goes out after a higher one", async ({
    db,
    tenant,
    outbox,
  }) => {
    // GIVEN a write transaction holding the lower outbox id open while a second
    // write, numbered after it, commits
    const fact = (subjectId: string) => ({
      tenantId: tenant,
      kind: "order",
      subjectId,
      payload: null,
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let allocated = (): void => {};
    const inFlight = new Promise<void>((resolve) => {
      allocated = resolve;
    });
    const first = db.transaction(async (tx) => {
      await tx.orm.orders.OutboxMessage.create(fact("first"));
      allocated();
      await held;
    });
    const published: string[] = [];
    const relay = () =>
      outbox.claim(tenant, 10, (batch) => {
        published.push(...batch.map(({ subjectId }) => subjectId));
        return OkAsync(batch.map(({ id }) => id));
      });

    // WHEN the relay sweeps while the first is in flight, and again once it
    // has committed
    const swept = await fromSafePromise(inFlight)
      .flatMap(() => fromSafePromise(db.orm.orders.OutboxMessage.create(fact("second"))))
      .flatMap(() => relay())
      .flatMap(() => {
        release();
        return fromSafePromise(first);
      })
      .flatMap(() => relay())
      .map(() => published);

    // THEN the relay published in COMMIT order, not id order: no claim can see
    // a row before it commits, which is why per-subject order rests on the
    // subject's own row serialising its writers
    expect(swept).toBeOkWith(["second", "first"]);
  });

  it("keeps its claim through a publish slower than the server's idle-in-transaction timeout", async ({
    tenant,
    repository,
    outbox,
    impatientOutbox,
    anOrder,
  }) => {
    // GIVEN a pending event, a relay on sessions the server ends after 200 ms
    // idle in a transaction, and a publisher that takes longer than that — a
    // real wait, because the timeout being outlived is the server's own clock
    const seenBySecond: (readonly OutboxMessage[])[] = [];
    const slowly = (ids: readonly number[]) =>
      fromSafePromise(delay(600)).flatMap(() =>
        outbox
          .claim(tenant, 10, (second) => {
            seenBySecond.push(second);
            return OkAsync(second.map(({ id }) => id));
          })
          .map(() => ids),
      );

    // WHEN the slow relay claims, and a second relay tries the tenant once the
    // timeout has passed
    const claimed = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000051", 1))
      .flatMap(() =>
        impatientOutbox.claim(tenant, 10, (batch) => slowly(batch.map(({ id }) => id))),
      )
      .flatMap(() => outbox.pending(tenant, 10))
      .map((pending) => ({ pending, seenBySecond }));

    // THEN the first relay still held the tenant and marked its row: the
    // second was handed nothing, and nothing is left to publish twice
    expect(claimed).toBeOkWith({ pending: [], seenBySecond: [] });
  });

  it("round-trips an outbox id past 2^31", async ({ db, tenant, outbox }) => {
    // GIVEN a pending row numbered beyond what an `int4` id could hold
    const id = 2 ** 31 + Math.floor(Math.random() * 2 ** 40);
    const handed: number[] = [];

    // WHEN it is claimed and published
    const swept = await fromSafePromise(
      db.orm.orders.OutboxMessage.create({
        id: BigInt(id),
        tenantId: tenant,
        kind: "order",
        subjectId: "0199a1e0-0000-7000-8000-000000000061",
        payload: null,
      }),
    )
      .flatMap(() =>
        outbox.claim(tenant, 10, (batch) => {
          handed.push(...batch.map((message) => message.id));
          return OkAsync(batch.map((message) => message.id));
        }),
      )
      .flatMap(() => outbox.pending(tenant, 10))
      .map((pending) => ({ handed, pending }));

    // THEN the relay was handed the exact id, and the mark found the row by it
    expect(swept).toBeOkWith({ handed: [id], pending: [] });
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
      .save(anOrder("0199a1e0-0000-7000-8000-000000000001", 3))
      .flatMap(() => repository.remove("0199a1e0-0000-7000-8000-000000000001"))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN the log carries both words about the subject, in order: what it
    // was, then that it is gone. A null payload IS the deletion — a reader
    // that keeps its own copy drops it here, and needs no second event type
    expect(events).toBeOkWith([
      expect.objectContaining({
        subjectId: "0199a1e0-0000-7000-8000-000000000001",
        payload: JSON.stringify({ quantity: 3 }),
      }),
      expect.objectContaining({ subjectId: "0199a1e0-0000-7000-8000-000000000001", payload: null }),
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
      .remove("o-absent")
      .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined))
      .flatMap(() => outbox.pending(tenant, 10));

    // THEN nothing was announced: the delete failed inside the transaction, so
    // the tombstone rolled back with it. A compensation that ran twice cannot
    // tell the world twice.
    expect(events).toBeOkWith([]);
  });

  it("does not hand one tenant another's pending events", async ({
    tenant,
    otherRepository,
    outbox,
    anOrder,
  }) => {
    // GIVEN a write committed by somebody else
    const events = await otherRepository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000502", 1))
      .flatMap(() => outbox.pending(tenant, 10));

    // WHEN this tenant's relay sweeps
    // THEN it has nothing to publish: the sweep is scoped by the tenant the
    // relay was configured with, which is what stops one deployment
    // broadcasting another's facts off a shared database
    expect(events).toBeOkWith([]);
  });
});
