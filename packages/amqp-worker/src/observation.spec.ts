import { describe, expect, vi } from "vitest";

import { it, type Observation } from "./__tests__/test-fixtures.js";

/**
 * The observations of one kind. A delivery and the library's own broker
 * diagnostics settle on the same set port, so a test says which it is about
 * rather than assuming the worker made exactly one.
 */
const named = (taken: () => readonly Observation[], name: string): readonly Observation[] =>
  taken().filter((observation) => observation.name === name);

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
    await vi.waitUntil(() => named(taken, "delivery").length === 1);

    // THEN the dimension is the contract's key, which is what bounds the
    // cardinality — the payload is nowhere near it
    expect(named(taken, "delivery")[0]).toEqual({
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
    await vi.waitUntil(() => named(taken, "delivery").length === 1);

    // THEN it settles as an error. This package nacks a defect straight to the
    // dead-letter queue, so an observation that skipped defects would report a
    // healthy rate beside a filling DLQ
    expect(named(taken, "delivery")[0]).toEqual({
      component: "amqp",
      name: "delivery",
      attributes: { handler: "echo" },
      outcome: "error",
    });
  });

  it("reports a poison delivery, which never reaches the handler middleware", async ({
    serveObserved,
    publishMessage,
  }) => {
    // GIVEN the same composition, and a payload the contract's own schema
    // refuses — another publisher on the same exchange, or a schema this
    // deployment has not caught up with
    const { taken } = await serveObserved();

    // WHEN it is delivered
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: 42 });
    await vi.waitUntil(() => named(taken, "broker").length >= 1);

    // THEN the library's own diagnostic is an observation. It is nacked before
    // the handler middleware runs, so the `delivery` operation — and the
    // `outcome` dimension a rate is read off — never sees it: a poison stream
    // used to present as a perfectly healthy worker beside a filling DLQ, with
    // the library writing its line into a logger it had never been given.
    expect(named(taken, "broker")[0]).toEqual(
      expect.objectContaining({
        component: "amqp",
        name: "broker",
        attributes: { level: "error" },
        outcome: "error",
      }),
    );
  });
});
