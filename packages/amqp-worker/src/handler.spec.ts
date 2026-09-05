import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

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

describe("amqp handler units", () => {
  it("hands a piece the ports it declared, built from the seeded delivery", async ({
    serveScoped,
    scoped,
    publishMessage,
  }) => {
    // GIVEN a worker whose `message` module derives a tenant from the delivery,
    // and a piece declaring that port on its own `unit:` record
    await serveScoped(scoped);

    // WHEN one message is published
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "acme" });
    await vi.waitUntil(() => scoped.seen().length === 1);

    // THEN what the handler read off `context.unit.tenant` came through the
    // seed: nothing else in the graph knows the payload
    expect(scoped.seen()).toEqual(["acme"]);
  });

  it("hands a piece that declared nothing an empty record", async ({
    serveSliced,
    slices,
    publishMessage,
  }) => {
    // GIVEN a worker with no `unit.message` bound, whose pieces declare no
    // `unit:` either
    await serveSliced(slices);

    // WHEN a delivery reaches them
    publishMessage({ exchange: "amqp-test", routingKey: "echo.requested" }, { value: "hello" });
    await vi.waitUntil(() => slices.ran().length === 2);

    // THEN `context.unit` is the empty record rather than absent, so a handler
    // reads it without asking whether a fork happened
    expect(slices.units()).toEqual([[]]);
  });
});
