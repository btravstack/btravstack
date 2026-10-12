import { fromSafePromise, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { relayOutbox } from "./index.js";
import { it } from "./test-fixtures.js";

describe("relayOutbox", () => {
  it("finishes each publication before starting the next", async ({ db, seedOutbox }) => {
    // GIVEN two committed events in insertion order
    await seedOutbox(2);
    const publications: unknown[] = [];

    // WHEN publication settles asynchronously
    await relayOutbox(db)((payload) => {
      publications.push(["start", payload]);
      return fromSafePromise(() =>
        Promise.resolve().then(() => {
          publications.push(["end", payload]);
        }),
      );
    });

    // THEN delivery preserves order across the asynchronous boundary
    expect(publications).toEqual([
      ["start", { sequence: 1 }],
      ["end", { sequence: 1 }],
      ["start", { sequence: 2 }],
      ["end", { sequence: 2 }],
    ]);
  });

  it("leaves rows beyond its bounded batch pending", async ({ db, seedOutbox }) => {
    // GIVEN a backlog larger than one batch
    await seedOutbox(101);

    // WHEN one relay invocation completes
    const delivered = await relayOutbox(db)(() => OkAsync());
    const pending = await db
      .selectFrom("outbox")
      .select("payload")
      .where("delivered_at", "is", null)
      .orderBy("position")
      .execute();

    // THEN the next invocation can take the remainder
    expect({ delivered: delivered.get(), pending }).toEqual({
      delivered: 100,
      pending: [{ payload: { sequence: 101 } }],
    });
  });

  it("marks successful rows and stops at the first publisher defect", async ({
    db,
    seedOutbox,
  }) => {
    // GIVEN three events and a publisher that fails on its second call
    await seedOutbox(3);
    const published: unknown[] = [];

    // WHEN the second publication defects inside the Result callback
    const result = await relayOutbox(db)((payload) => {
      published.push(payload);
      return OkAsync().map(() => {
        if (published.length === 2) {
          // oxlint-disable-next-line unthrown/no-throw -- a defective upstream publisher is under test
          throw new Error("publisher unavailable");
        }
      });
    });
    const rows = await db
      .selectFrom("outbox")
      .select(["payload", "delivered_at"])
      .orderBy("position")
      .execute();

    // THEN the successful row stays marked, and no later publication starts
    expect({
      defect: result.isDefect(),
      published,
      rows: rows.map((row) => ({
        payload: row.payload,
        delivered: row.delivered_at !== null,
      })),
    }).toEqual({
      defect: true,
      published: [{ sequence: 1 }, { sequence: 2 }],
      rows: [
        { payload: { sequence: 1 }, delivered: true },
        { payload: { sequence: 2 }, delivered: false },
        { payload: { sequence: 3 }, delivered: false },
      ],
    });
  });
});
