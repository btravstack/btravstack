import { describe, expect, vi } from "vitest";

import { OrderAmqpModule } from "./module.js";
import { it } from "./test-fixtures.js";

describe("orderAmqpRuntime", () => {
  it("places an order through a real delivery", async ({ serve, tapped, publishMessage }) => {
    // GIVEN the same composition the API, the queue worker and the Temporal
    // worker boot — `ApplicationModule` and `PersistenceModule`, unchanged —
    // consumed by a real broker instead
    await serve(tapped.module);

    // WHEN a placement is published over the real exchange and routed by the
    // real contract to the real queue
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-1", quantity: 2 },
      { messageId: "m-1" },
    );
    await vi.waitUntil(() => tapped.lines().length === 1);

    // THEN the payload the wire carried reached the use case intact — decoded,
    // routed and resolved through the real DI graph — under the publisher's
    // own message id as the trace
    expect(tapped.lines()).toEqual(["[m-1] placing order o-1 (quantity 2)"]);
  });

  it("parks the DuplicateOrder the API answers CONFLICT for, rather than retrying it", async ({
    serve,
    publishMessage,
    initConsumer,
  }) => {
    // GIVEN a worker consuming the real deployment, and a consumer of its own
    // bound to the dead-letter exchange the contract parks to. Bound only
    // after the worker has declared the topology — `orders-dlx` does not exist
    // until `TypedAmqpWorker.create` declares it.
    await serve(OrderAmqpModule);
    const waitForParked = await initConsumer("orders-dlx", "order.placement.requested");

    // WHEN two placements for the same order id are published. AMQP has no
    // request/response to chain on the way `order-temporal`'s
    // `executeWorkflow` and `order-worker`'s `queue.publish` do, so both are
    // sent without waiting — the database's own uniqueness constraint decides
    // which one wins regardless of delivery order, the same guarantee the real
    // repository gives `order-infrastructure`'s own suite
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-1", quantity: 2 },
      { messageId: "m-1" },
    );
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-1", quantity: 2 },
      { messageId: "m-2" },
    );

    // THEN the load-bearing assertion of this whole example: the identical
    // `Err` the oRPC runtime turns into an inferable CONFLICT and the queue
    // worker dead-letters is here a `NonRetryableError`, parked on the DLQ
    // without ever touching the retry budget. `NonRetryableError` routes
    // straight to `orders-dlx` on the first attempt — never through a wait
    // queue — so the parked copy still carries its original routing key.
    const parked = await waitForParked();
    expect(parked.map((message) => JSON.parse(message.content.toString())) as unknown[]).toEqual([
      { orderId: "o-1", quantity: 2 },
    ]);
  });

  it("lets the broker retry a Defect recovered into a RetryableError, up to the contract's own budget", async ({
    serve,
    unmodelled,
    publishMessage,
    initConsumer,
  }) => {
    // GIVEN a repository whose failure nobody modelled, so it is a `Defect` —
    // which this branch's doctrine says the broker does NOT retry on its own.
    // The four attempts below happen only because `placeHandler`'s
    // `recoverDefect` turns it into a `RetryableError` first, and the
    // dead-letter exchange it eventually lands on once retries run out
    await serve(unmodelled.module);
    const waitForParked = await initConsumer("orders-dlx", "order-placements");

    // WHEN a delivery reaches it. Each `ttl-backoff` retry republishes through
    // a wait queue via the default exchange, so by the time the third and
    // final attempt is exhausted the message's routing key is the main
    // queue's own name rather than the original one — the counterpart to
    // `order-temporal`'s "lets Temporal retry an unmodelled failure"
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-1", quantity: 1 },
    );
    await waitForParked();

    // THEN the third channel takes the third route again, and this time the
    // broker owns it: an unnamed failure gets `maxRetries: 3` retries on top
    // of its first try — four attempts in total, unlike Temporal's
    // `maximumAttempts` which counts the first try as one of its three. The
    // two named failures are parked on the first attempt instead. The queue
    // worker hand-rolls this with an attempt budget; here it is a line of
    // contract.
    expect(unmodelled.attempts()).toBe(4);
  });

  it("publishes the queue it drains on Serving.info", async ({ serve }) => {
    // GIVEN a worker consuming the contract's one queue
    const app = await serve(OrderAmqpModule);

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN the same channel the API publishes `{ port, prefix }` on, the queue
    // worker `{ queue, concurrency }` and Temporal `{ taskQueue, namespace }`
    // carries the set of queues an operator would look at in the management UI
    await expect(info).toBeOkWith({ queues: ["order-placements"] });
  });

  it("runs each delivery in its own unit, with its own trace id", async ({
    serve,
    tapped,
    publishMessage,
  }) => {
    // GIVEN the real graph with the very `Logger` instance the use cases write to
    await serve(tapped.module);

    // WHEN two placements are delivered, each carrying its own publisher-minted message id
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-1", quantity: 1 },
      { messageId: "m-1" },
    );
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-2", quantity: 1 },
      { messageId: "m-2" },
    );
    await vi.waitUntil(() => tapped.traces().length === 2);

    // THEN two deliveries, two units, two distinct trace ids — each the
    // publisher's own message id — and never the out-of-unit `[-]`. The unit
    // id is minted per delivery, since a delivery tag restarts at 1 after a
    // reconnect and cannot carry the kernel's uniqueness rule. Sorted before
    // comparing: unlike a Temporal workflow execution or a single in-memory
    // queue, nothing here guarantees the broker delivers two independent
    // publishes in send order.
    expect([...tapped.traces()].sort()).toEqual(["[m-1]", "[m-2]"]);
  });

  it("lets an in-flight delivery finish while draining", async ({
    serve,
    gate,
    publishMessage,
  }) => {
    // GIVEN a delivery held open inside the repository, through the real
    // broker rather than the generic `Greeting` fixture `@btravstack/start-amqp`
    // itself is tested against
    const app = await serve(gate.module);
    publishMessage(
      { exchange: "orders", routingKey: "order.placement.requested" },
      { orderId: "o-1", quantity: 1 },
    );
    await gate.arrived;

    // WHEN the drain starts and the delivery is released only once the phase
    // moved. `vi.waitUntil` synchronises rather than asserts — the drain
    // samples `inFlightAtStart` in the same synchronous turn that advances the
    // phase, so releasing afterwards is what makes the report exact rather
    // than racy.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the kernel counted it as one unit that COMPLETED, through this
    // deployment's own real composition rather than the package's synthetic one
    const report = await app.exited;
    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });
});
