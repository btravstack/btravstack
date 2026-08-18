import type { Line } from "@btravstack/observability";
import { describe, expect, vi } from "vitest";

import { it } from "./test-fixtures.js";

/**
 * The notification lines as `{ message, ...attributes }` — what the consumer
 * said, and about which order. The `unit` every line also carries is the
 * package's own concern, not this suite's, so it is projected away rather
 * than parsed out of a string.
 */
const notifications = (lines: readonly Line[]) =>
  lines
    .filter((line) => line.message.includes("notifying"))
    .map((line) => ({ message: line.message, ...line.attributes }));

describe("the broadcast deployment", () => {
  it("broadcasts every committed write, end to end", async ({ asTenant, serve, tapped }) => {
    // GIVEN the app serving: relay sweeping the outbox, consumer on the queue
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN an order is placed — one ordinary write, no publish in sight
    await expect(asTenant(() => placeOrder.execute("o-1", 2))).resolves.toBeOkWith(
      expect.objectContaining({ id: "o-1" }),
    );

    // THEN the fact crosses the outbox, the broker and the queue, and the
    // consumer reacts — the write-side never spoke AMQP
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toContainEqual({ message: "order placed — notifying", orderId: "o-1", quantity: 2 });
  });

  it("marks relayed events published, exactly once each", async ({
    asTenant,
    tenant,
    serve,
    tapped,
  }) => {
    // GIVEN a served app and a committed write
    await serve(tapped.module);
    const { placeOrder, outbox } = tapped.services();
    await expect(asTenant(() => placeOrder.execute("o-2", 1))).resolves.toBeOk();

    // WHEN the relay has swept it
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toContainEqual({ message: "order placed — notifying", orderId: "o-2", quantity: 1 });

    // THEN nothing is left pending — the next sweep has nothing to re-publish
    await expect(outbox.pending(tenant, 10)).toBeOkWith([]);
  });

  it("relays in commit order", async ({ asTenant, serve, tapped }) => {
    // GIVEN a served app
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN two writes commit in order
    await expect(asTenant(() => placeOrder.execute("o-3", 1))).resolves.toBeOk();
    await expect(asTenant(() => placeOrder.execute("o-4", 1))).resolves.toBeOk();

    // THEN the notifications arrive in the same order: the relay publishes by
    // outbox id, the queue preserves it, the consumer is sequential
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toEqual([
        { message: "order placed — notifying", orderId: "o-3", quantity: 1 },
        { message: "order placed — notifying", orderId: "o-4", quantity: 1 },
      ]);
  });

  it("broadcasts the cancellation as a tombstone, after the placement", async ({
    asTenant,
    serve,
    tapped,
  }) => {
    // GIVEN a served app and a placed order
    await serve(tapped.module);
    const { placeOrder, repository } = tapped.services();
    await expect(asTenant(() => placeOrder.execute("o-6", 2))).resolves.toBeOk();

    // WHEN the order is cancelled — the write path the saga's compensation uses
    await expect(asTenant(() => repository.remove("o-6"))).resolves.toBeOk();

    // THEN the subscriber hears both words about the subject, in order: what
    // it was, then that it is gone. Without the tombstone a reader keeping its
    // own copy would hold a cancelled order forever.
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toEqual([
        { message: "order placed — notifying", orderId: "o-6", quantity: 2 },
        { message: "order gone — notifying", orderId: "o-6" },
      ]);
  });

  it("is a broadcast: a subscriber this repo never heard of receives it too", async ({
    asTenant,
    tenant,
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
    await expect(asTenant(() => tapped.services().placeOrder.execute("o-5", 4))).resolves.toBeOk();

    // THEN the foreign queue receives the same fact the notifier does — the
    // publisher addressed an exchange, never a consumer
    const [message] = await waitForMessages({ count: 1, timeoutMs: 5_000 });
    expect(JSON.parse(String(message?.content))).toEqual({
      tenantId: tenant,
      kind: "order",
      id: "o-5",
      occurredAt: expect.any(String),
      payload: { quantity: 4 },
    });
  });

  it("delivers one committed fact to every subscriber", async ({ asTenant, serve, tapped }) => {
    // GIVEN a worker whose two slices each drain their own queue off the one
    // orders exchange
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN one order is placed, so the relay publishes exactly one event
    await expect(asTenant(() => placeOrder.execute("o-7", 2))).resolves.toBeOk();

    // THEN both subscribers logged it — a broadcast, not a work queue. The
    // writer's own line is named rather than filtered out by "has no kernel
    // unit": a multi-tenant write runs inside a unit too (that is where its
    // tenant comes from), so carrying a `unit` no longer tells a subscriber's
    // line from the placement's.
    const subscriberLines = () =>
      tapped
        .lines()
        .filter((line) => line.unit !== undefined && line.message !== "placing an order");
    await vi.waitUntil(() => subscriberLines().length === 2, { timeout: 5_000 });
    expect(
      subscriberLines()
        .map((line) => line.message)
        .sort(),
    ).toEqual(["order placed — notifying", "recording an order change"]);
  });
});
