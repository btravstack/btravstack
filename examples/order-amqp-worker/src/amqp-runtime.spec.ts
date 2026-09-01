import type { OrderEvent } from "@btravstack/example-order-application";
import type { Line } from "@btravstack/observability";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

/**
 * The notification lines as `{ message, ...attributes }` — what the consumer
 * said, and about which order. The `unit` every line also carries is the
 * package's own concern, not this suite's, so it is projected away rather
 * than parsed out of a string.
 */
const notifications = (lines: readonly Line[]) =>
  lines
    .filter((line) => line.message.includes("notifying"))
    // `tenantId` is projected away: every line in a test carries the same one,
    // so asserting it in every expectation would be noise. That the tenant
    // crossed the broker at all is pinned once, by the foreign-subscriber spec
    // below reading it off the wire.
    .map(({ message, attributes }) => ({
      message,
      ...attributes,
      tenantId: undefined,
    }))
    .map(({ tenantId: _tenantId, ...line }) => line);

describe("the broadcast deployment", () => {
  it("broadcasts every committed write, end to end", async ({ tenant, serve, tapped }) => {
    // GIVEN the app serving: relay sweeping the outbox, consumer on the queue
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN an order is placed — one ordinary write, no publish in sight
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000001", 2)).toBeOkWith(
      expect.objectContaining({ id: "0199a1e0-0000-7000-8000-000000000001" }),
    );

    // THEN the fact crosses the outbox, the broker and the queue, and the
    // consumer reacts — the write-side never spoke AMQP
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toContainEqual({
        message: "order placed — notifying",
        orderId: "0199a1e0-0000-7000-8000-000000000001",
        quantity: 2,
      });
  });

  it("marks relayed events published, exactly once each", async ({ tenant, serve, tapped }) => {
    // GIVEN a served app and a committed write
    await serve(tapped.module);
    const { placeOrder, outbox } = tapped.services();
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000002", 1)).toBeOk();
    const pending = async (): Promise<readonly OrderEvent[]> =>
      (await outbox.pending(tenant, 10)).get();

    // WHEN the relay has swept it. Synchronising on the MARK, not on the
    // notification: a subscriber's line proves the publish happened, and
    // `markPublished` runs after it — so waiting on the line and asserting on
    // the outbox is waiting for one resource and asserting about another,
    // which is a race the machine wins about half the time under load.
    await vi.waitUntil(async () => (await pending()).length === 0, { timeout: 5_000 });

    // THEN nothing is left pending — the next sweep has nothing to re-publish —
    // and the subscriber heard it exactly once, which is the other half of the
    // claim and what a re-published event would break
    expect({ pending: await pending(), notified: notifications(tapped.lines()) }).toEqual({
      pending: [],
      notified: [
        {
          message: "order placed — notifying",
          orderId: "0199a1e0-0000-7000-8000-000000000002",
          quantity: 1,
        },
      ],
    });
  });

  it("relays in commit order", async ({ tenant, serve, tapped }) => {
    // GIVEN a served app
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN two writes commit in order
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000003", 1)).toBeOk();
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000004", 1)).toBeOk();

    // THEN the notifications arrive in the same order: the relay publishes by
    // outbox id, the queue preserves it, the consumer is sequential
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toEqual([
        {
          message: "order placed — notifying",
          orderId: "0199a1e0-0000-7000-8000-000000000003",
          quantity: 1,
        },
        {
          message: "order placed — notifying",
          orderId: "0199a1e0-0000-7000-8000-000000000004",
          quantity: 1,
        },
      ]);
  });

  it("broadcasts the cancellation as a tombstone, after the placement", async ({
    tenant,
    serve,
    tapped,
  }) => {
    // GIVEN a served app and a placed order
    await serve(tapped.module);
    const { placeOrder, repository } = tapped.services();
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000006", 2)).toBeOk();

    // WHEN the order is cancelled — the write path the saga's compensation uses
    await expect(repository.remove(tenant, "0199a1e0-0000-7000-8000-000000000006")).toBeOk();

    // THEN the subscriber hears both words about the subject, in order: what
    // it was, then that it is gone. Without the tombstone a reader keeping its
    // own copy would hold a cancelled order forever.
    await expect
      .poll(() => notifications(tapped.lines()), { timeout: 5_000 })
      .toEqual([
        {
          message: "order placed — notifying",
          orderId: "0199a1e0-0000-7000-8000-000000000006",
          quantity: 2,
        },
        { message: "order gone — notifying", orderId: "0199a1e0-0000-7000-8000-000000000006" },
      ]);
  });

  it("is a broadcast: a subscriber this repo never heard of receives it too", async ({
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
    await expect(
      tapped.services().placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000005", 4),
    ).toBeOk();

    // THEN the foreign queue receives the same fact the notifier does — the
    // publisher addressed an exchange, never a consumer
    const [message] = await waitForMessages({ count: 1, timeoutMs: 5_000 });
    expect(JSON.parse(String(message?.content))).toEqual({
      tenantId: tenant,
      kind: "order",
      id: "0199a1e0-0000-7000-8000-000000000005",
      occurredAt: expect.any(String),
      payload: { quantity: 4 },
    });
  });

  it("sends the notification out through a real relay", async ({
    tenant,
    serve,
    tapped,
    delivered,
  }) => {
    // GIVEN the worker serving, with its notifications slice on the shared
    // SMTP server
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN one order is placed, so the relay publishes and the subscriber
    // notifies
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000009", 3)).toBeOk();

    // THEN a mail for this tenant reached the server — the proof the port is
    // wired to a transport and not to a stub, which no recording adapter
    // could give
    await vi.waitUntil(async () => (await delivered(tenant)).length === 1, { timeout: 10_000 });
    expect((await delivered(tenant))[0]).toEqual(
      expect.objectContaining({
        To: [expect.objectContaining({ Address: `tenant-${tenant}@example.test` })],
        Subject: "order 0199a1e0-0000-7000-8000-000000000009 placed",
      }),
    );
  });

  it("delivers one committed fact to every subscriber", async ({ tenant, serve, tapped }) => {
    // GIVEN a worker whose two slices each drain their own queue off the one
    // orders exchange
    await serve(tapped.module);
    const { placeOrder } = tapped.services();

    // WHEN one order is placed, so the relay publishes exactly one event
    await expect(placeOrder.execute(tenant, "0199a1e0-0000-7000-8000-000000000007", 2)).toBeOk();

    // THEN both subscribers logged it — a broadcast, not a work queue. The
    // writer's own line is named rather than filtered out by "has no kernel
    // unit": a multi-tenant write runs inside a unit too (that is where its
    // tenant comes from), so carrying a `unit` no longer tells a subscriber's
    // line from the placement's.
    //
    // TWO lines, not three: the mailer's own "mail sent" is gone with the
    // `instrumented` flag. A successful send is what its metric and span are
    // for, and the starter no longer holds a `Logger` to write a line of its
    // own — an application that wants an operator to see every send writes
    // that line where it sends.
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
