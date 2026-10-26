import { Temporal } from "temporal-polyfill";
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
  it("preserves an appended instant through reads and claims", async ({ store }) => {
    // GIVEN
    const occurredAt = Temporal.Instant.from("2026-10-26T12:00:00.123456Z");
    store.append({ ...order("a"), occurredAt });
    const claimed: bigint[] = [];

    // WHEN
    const timestamps = await store.pending("acme", 1).flatMap((pending) =>
      store
        .claim("acme", 1, (batch) => {
          claimed.push(...batch.map((message) => message.occurredAt.epochNanoseconds));
          return OkAsync(batch.map(({ id }) => id));
        })
        .map(() => ({
          pending: pending.map((message) => message.occurredAt.epochNanoseconds),
          claimed,
        })),
    );

    // THEN
    expect(timestamps).toBeOkWith({
      pending: [occurredAt.epochNanoseconds],
      claimed: [occurredAt.epochNanoseconds],
    });
  });

  it("finds the oldest timestamp independently of append order", async ({ store }) => {
    // GIVEN
    store.append({
      ...order("a"),
      occurredAt: Temporal.Instant.from("2026-10-26T12:00:00.123457Z"),
    });
    const oldest = Temporal.Instant.from("2026-10-26T12:00:00.123456Z");
    store.append({ ...order("b"), occurredAt: oldest });

    // WHEN
    const timestamps = await store.oldestPending(["acme", "empty"]).map((pending) =>
      pending.map(({ tenantId, occurredAt }) => ({
        tenantId,
        nanoseconds: occurredAt.epochNanoseconds,
      })),
    );

    // THEN
    expect(timestamps).toBeOkWith([{ tenantId: "acme", nanoseconds: oldest.epochNanoseconds }]);
  });

  it("stamps each appended message with the next id and the clock's time", async ({ store }) => {
    // GIVEN two appends
    store.append(order("a"));
    store.append(order("b"));

    // WHEN the tenant's pending messages are read
    const pending = await store.pending("acme", 10);

    // THEN they come back in outbox order, stamped
    expect(pending).toBeOkWith([
      { ...order("a"), id: 1, occurredAt: Temporal.Instant.fromEpochMilliseconds(1_000_000) },
      { ...order("b"), id: 2, occurredAt: Temporal.Instant.fromEpochMilliseconds(1_000_000) },
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

  it("prunes only what was published longer ago than the age, at most the limit", async ({
    store,
    clock,
  }) => {
    // GIVEN three messages, the first two published ten milliseconds ago
    for (const id of ["a", "b", "c"]) store.append(order(id));

    // WHEN the tenant is pruned of anything older than five, one at a time
    const pruned = await store
      .claim("acme", 2, (batch) => OkAsync(batch.map(({ id }) => id)))
      .flatMap(() => clock.advance(10))
      .flatMap(() => store.prune("acme", 5, 1))
      .flatMap((first) =>
        store
          .prune("acme", 5, 1)
          .flatMap((second) => store.prune("acme", 5, 1).map((third) => [first, second, third])),
      )
      .flatMap((counts) =>
        store
          .pending("acme", 10)
          .map((pending) => ({ counts, pending: pending.map(({ subjectId }) => subjectId) })),
      );

    // THEN each published message went once, and the pending one stayed
    expect(pruned).toBeOkWith({ counts: [1, 1, 0], pending: ["c"] });
  });

  it("prunes nothing published within the age, nor another tenant's", async ({ store, clock }) => {
    // GIVEN one published message in each of two tenants, ten milliseconds ago
    store.append(order("a"));
    store.append({ ...order("b"), tenantId: "globex" });

    // WHEN acme is pruned of what is older than ten, then of what is older than five
    const pruned = await store
      .claim("acme", 10, (batch) => OkAsync(batch.map(({ id }) => id)))
      .flatMap(() => store.claim("globex", 10, (batch) => OkAsync(batch.map(({ id }) => id))))
      .flatMap(() => clock.advance(10))
      .flatMap(() => store.prune("acme", 10, 10))
      .flatMap((exactlyTheAge) =>
        store.prune("acme", 5, 10).map((acme) => ({ exactlyTheAge, acme })),
      );

    // THEN the age is exclusive, and globex's row was never a candidate
    expect(pruned).toBeOkWith({ exactlyTheAge: 0, acme: 1 });
  });

  it("prunes nothing of a tenant a claim holds", async ({ store, clock }) => {
    // GIVEN one message published long enough ago to prune, and a second claim
    // in progress over a new one
    store.append(order("a"));
    const during: number[] = [];

    // WHEN the tenant is pruned while that claim holds it
    await store
      .claim("acme", 10, (batch) => OkAsync(batch.map(({ id }) => id)))
      .flatMap(() => clock.advance(10))
      .flatMap(() => {
        store.append(order("b"));
        return store.claim("acme", 10, (batch) =>
          store.prune("acme", 5, 10).map((count) => {
            during.push(count);
            return batch.map(({ id }) => id);
          }),
        );
      });

    // THEN the prune skipped it, as a second claim would, though `a` was due
    expect(during).toEqual([0]);
  });
});
