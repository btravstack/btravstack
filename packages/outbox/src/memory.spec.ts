import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import type { OutboxMessage } from "./outbox.js";

const order = (subjectId: string) => ({
  tenantId: "acme",
  kind: "order",
  subjectId,
  payload: null,
});

describe("memoryOutboxStore", () => {
  it("stamps each appended message with the next id and the clock's time", async ({ store }) => {
    // GIVEN two appends
    store.append(order("a"));
    store.append(order("b"));

    // WHEN the tenant's pending messages are read
    const pending = await store.pending("acme", 10);

    // THEN they come back in outbox order, stamped
    expect(pending).toBeOkWith([
      { ...order("a"), id: 1, occurredAt: new Date(1_000_000) },
      { ...order("b"), id: 2, occurredAt: new Date(1_000_000) },
    ]);
  });

  it("skips a tenant another caller has claimed", async ({ store }) => {
    // GIVEN a pending message
    store.append(order("a"));
    const second: (readonly OutboxMessage[])[] = [];

    // WHEN a second claim arrives while the first holds the tenant
    const claimed = await store
      .claim("acme", 10, (batch) =>
        store
          .claim("acme", 10, (seen) => {
            second.push(seen);
            return OkAsync([]);
          })
          .map(() => batch.map(({ id }) => id)),
      )
      .map(() => second);

    // THEN the second was never handed a batch
    expect(claimed).toBeOkWith([]);
  });

  it("marks nothing and releases the tenant when the relay dies", async ({ store }) => {
    // GIVEN a pending message, and a claim whose relay defects
    store.append(order("a"));
    const died = store
      .claim("acme", 10, () => fromSafePromise(Promise.reject(new Error("crashed"))))
      .recoverDefect(() => OkAsync(undefined));

    // WHEN the tenant is claimed again
    const next = await died
      .flatMap(() => store.claim("acme", 10, (batch) => OkAsync(batch.map(({ id }) => id))))
      .flatMap(() => store.pending("acme", 10));

    // THEN the second claim was handed the message the first could not mark
    expect(next).toBeOkWith([]);
  });
});
