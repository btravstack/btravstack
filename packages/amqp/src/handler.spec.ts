import { describe, expect, vi } from "vitest";

import { it } from "./test-fixtures.js";

describe("amqp handler slices", () => {
  it("serves a record composed from one piece per consumer", async ({
    serveSliced,
    slices,
    publishMessage,
  }) => {
    // GIVEN a worker whose handlers were composed from two slices, each owning
    // one consumer of the same broadcast
    await serveSliced(slices);

    // WHEN one message is published to the exchange both queues bind to
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "hello" });
    await vi.waitUntil(() => slices.ran().length === 2);

    // THEN both slices ran, so every piece was mounted under its own key
    expect([...slices.ran()].sort()).toEqual(["left", "right"]);
  });

  it("builds each piece from the ports its own provider declared", async ({
    serveSliced,
    slices,
    publishMessage,
  }) => {
    // GIVEN the same two slices, of which only `left` declares `Greeting`
    await serveSliced(slices);

    // WHEN a delivery reaches them
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "hello" });
    await vi.waitUntil(() => slices.ran().length === 2);

    // THEN the one that declared it closed over the application's own service
    expect(slices.greeting()).toBe("hello");
  });
});
