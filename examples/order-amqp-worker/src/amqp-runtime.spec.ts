import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

/**
 * The notification lines, with the message unit's `[trace]` prefix stripped —
 * what the consumer said is the assertion; that the middleware traced it is
 * the package's own concern.
 */
const notifications = (lines: readonly string[]): readonly string[] =>
  lines
    .filter((line) => line.includes("notifying"))
    .map((line) => line.slice(line.indexOf("]") + 2));

describe("the broadcast deployment", () => {
  it("broadcasts every committed write, end to end", async ({ serve, tapped }) => {
    // GIVEN the app serving: relay sweeping the outbox, consumer on the queue
    await serve(tapped.module);
    const { placeOrder, logger } = tapped.services();

    // WHEN an order is placed — one ordinary write, no publish in sight
    await expect(placeOrder.execute("o-1", 2)).toBeOkWith(expect.objectContaining({ id: "o-1" }));

    // THEN the fact crosses the outbox, the broker and the queue, and the
    // consumer reacts — the write-side never spoke AMQP
    await expect
      .poll(() => notifications(tapped.services().logger.lines()), { timeout: 5_000 })
      .toContain("order o-1 placed — notifying (2 items)");
    void logger;
  });

  it("marks relayed events published, exactly once each", async ({ serve, tapped }) => {
    // GIVEN a served app and a committed write
    await serve(tapped.module);
    const { placeOrder, outbox } = tapped.services();
    await expect(placeOrder.execute("o-2", 1)).toBeOk();

    // WHEN the relay has swept it
    await expect
      .poll(() => notifications(tapped.services().logger.lines()), { timeout: 5_000 })
      .toContain("order o-2 placed — notifying (1 items)");

    // THEN nothing is left pending — the next sweep has nothing to re-publish
    await expect(outbox.pending(10)).toBeOkWith([]);
  });

  it("relays in commit order", async ({ serve, tapped }) => {
    // GIVEN a served app
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN two writes commit in order
    await expect(placeOrder.execute("o-3", 1)).toBeOk();
    await expect(placeOrder.execute("o-4", 1)).toBeOk();

    // THEN the notifications arrive in the same order: the relay publishes by
    // outbox id, the queue preserves it, the consumer is sequential
    await expect
      .poll(() => notifications(tapped.services().logger.lines()), { timeout: 5_000 })
      .toEqual([
        "order o-3 placed — notifying (1 items)",
        "order o-4 placed — notifying (1 items)",
      ]);
  });

  it("broadcasts the cancellation as a tombstone, after the placement", async ({
    serve,
    tapped,
  }) => {
    // GIVEN a served app and a placed order
    await serve(tapped.module);
    const { placeOrder, repository } = tapped.services();
    await expect(placeOrder.execute("o-6", 2)).toBeOk();

    // WHEN the order is cancelled — the write path the saga's compensation uses
    await expect(repository.remove("o-6")).toBeOk();

    // THEN the subscriber hears both words about the subject, in order: what
    // it was, then that it is gone. Without the tombstone a reader keeping its
    // own copy would hold a cancelled order forever.
    await expect
      .poll(() => notifications(tapped.services().logger.lines()), { timeout: 5_000 })
      .toEqual(["order o-6 placed — notifying (2 items)", "order o-6 is gone — notifying"]);
  });

  it("is a broadcast: a subscriber this repo never heard of receives it too", async ({
    serve,
    tapped,
    initConsumer,
  }) => {
    // GIVEN a served app — whose worker declares the `orders` exchange — AND
    // a foreign subscriber: its own queue, bound to the same exchange,
    // declared by nothing in this contract
    await serve(tapped.module);
    const waitForMessages = await initConsumer("orders", "order.changed");

    // WHEN an order is placed
    await expect(tapped.services().placeOrder.execute("o-5", 4)).toBeOk();

    // THEN the foreign queue receives the same fact the notifier does — the
    // publisher addressed an exchange, never a consumer
    const [message] = await waitForMessages({ count: 1, timeoutMs: 5_000 });
    expect(JSON.parse(String(message?.content))).toEqual({
      kind: "order",
      id: "o-5",
      occurredAt: expect.any(String),
      payload: { quantity: 4 },
    });
  });
});
