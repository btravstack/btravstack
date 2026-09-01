import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the worker's RED metrics", () => {
  it("counts a delivery and times it, dimensioned by handler and outcome", async ({
    serveMetered,
    publishMessage,
  }) => {
    // GIVEN the default composition — `instrumented` is on unless a root says
    // otherwise — with a meter that records
    const { taken } = await serveMetered();

    // WHEN one message is delivered
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "x" });
    await vi.waitUntil(() => taken().length === 2);

    // THEN both instruments carry the contract's own handler key, which is what
    // bounds the cardinality — the payload is nowhere near the attributes
    expect(taken().map(({ instrument, attributes }) => ({ instrument, attributes }))).toEqual([
      {
        instrument: "btravstack.amqp.deliveries",
        attributes: { handler: "echo", outcome: "ok" },
      },
      {
        instrument: "btravstack.amqp.duration",
        attributes: { handler: "echo", outcome: "ok" },
      },
    ]);
  });

  it("counts a delivery nobody modelled as an error, not as a silence", async ({
    serveMetered,
    publishMessage,
    failing,
  }) => {
    // GIVEN the same composition over a handler that defects
    const { taken } = await serveMetered(failing);

    // WHEN one message is delivered
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "x" });
    await vi.waitUntil(() => taken().length === 2);

    // THEN the errors half of RED sees it — a count that skipped defects would
    // report a healthy rate while every delivery went to the dead-letter queue
    expect(taken()[0]).toEqual({
      instrument: "btravstack.amqp.deliveries",
      value: 1,
      attributes: { handler: "echo", outcome: "error" },
    });
  });
});
