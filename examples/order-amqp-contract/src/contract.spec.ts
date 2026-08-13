import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("orderContract", () => {
  it("routes the broadcast through a queue that parks what it cannot retry", ({ contract }) => {
    // GIVEN the contract as any worker or publisher would take it
    // WHEN its queue is read
    const queue = contract.queues["order-notifications"];

    // THEN the retry budget and the parking bay are the contract's, not a
    // constant in some deployment's runtime
    expect(queue).toEqual(
      expect.objectContaining({
        name: "order-notifications",
        deadLetter: expect.objectContaining({
          exchange: expect.objectContaining({ name: "orders-dlx" }),
        }),
        retry: expect.objectContaining({ mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 }),
      }),
    );
  });

  it("names the event as a fact, not a command", ({ contract }) => {
    // GIVEN the publisher any relay would take
    // WHEN its routing key is read
    // THEN it announces something that happened — past tense, no addressee —
    // and it is ONE key for every change, because a reader compacting by `id`
    // needs a subject's create and its tombstone in one ordered stream
    expect(contract.publishers.orderChanged.routingKey).toBe("order.changed");
  });

  it("validates a broadcast event from the contract alone", ({ validate }) => {
    // GIVEN the contract's own schema, and nothing else — no worker, no
    // connection, no broker
    const event = {
      kind: "order",
      id: "o-1",
      occurredAt: "2026-08-13T22:00:00.000Z",
      payload: { quantity: 2 },
    };

    // WHEN a relay checks the envelope it is about to publish
    // THEN it is accepted, in the shape the wire will carry
    expect(validate(event)).toBeOkWith(event);
  });

  it("accepts a tombstone — the deletion is a null payload, not a second event type", ({
    validate,
  }) => {
    // GIVEN the same schema
    const tombstone = {
      kind: "order",
      id: "o-1",
      occurredAt: "2026-08-13T22:00:00.000Z",
      payload: null,
    };

    // WHEN the relay checks the last word about a subject
    // THEN the contract carries it: this is what lets one stream and one
    // handler express create, replace and delete without a second message
    expect(validate(tombstone)).toBeOkWith(tombstone);
  });

  it("rejects a payload the wire should never carry", ({ validate }) => {
    // GIVEN the same schema

    // WHEN the quantity arrives as a string, the way an untyped publisher sends it
    // THEN it is rejected as a value, naming the field — the contract is
    // executable, not documentation, and a caller can run it
    expect(
      validate({
        kind: "order",
        id: "o-1",
        occurredAt: "2026-08-13T22:00:00.000Z",
        payload: { quantity: "two" },
      }),
    ).toBeErrWith([expect.objectContaining({ path: ["payload", "quantity"] })]);
  });
});
