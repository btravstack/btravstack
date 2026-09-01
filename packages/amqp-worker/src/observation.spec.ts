import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the worker's observations", () => {
  it("observes a delivery, dimensioned by the contract's own handler key", async ({
    serveObserved,
    publishMessage,
  }) => {
    // GIVEN the worker over an observer that records — which is all a graph
    // does to be observed: the starter asks for no ports
    const { taken } = await serveObserved();

    // WHEN one message is delivered
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "x" });
    await vi.waitUntil(() => taken().length === 1);

    // THEN the dimension is the contract's key, which is what bounds the
    // cardinality — the payload is nowhere near it
    expect(taken()[0]).toEqual({
      component: "amqp",
      name: "delivery",
      attributes: { handler: "echo" },
      outcome: "ok",
    });
  });

  it("settles a delivery nobody modelled as an error, not as a silence", async ({
    serveObserved,
    publishMessage,
    failing,
  }) => {
    // GIVEN the same composition over a handler that defects
    const { taken } = await serveObserved(failing);

    // WHEN one message is delivered
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "x" });
    await vi.waitUntil(() => taken().length === 1);

    // THEN it settles as an error. This package nacks a defect straight to the
    // dead-letter queue, so an observation that skipped defects would report a
    // healthy rate beside a filling DLQ
    expect(taken()[0]).toEqual({
      component: "amqp",
      name: "delivery",
      attributes: { handler: "echo" },
      outcome: "error",
    });
  });
});
