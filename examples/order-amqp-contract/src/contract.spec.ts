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
    // THEN it announces something that happened — past tense, no addressee
    expect(contract.publishers.orderPlaced.routingKey).toBe("order.placed");
  });

  it("validates a broadcast payload from the contract alone", ({ validate }) => {
    // GIVEN the contract's own schema, and nothing else — no worker, no
    // connection, no broker

    // WHEN a relay checks the payload it is about to publish
    // THEN it is accepted, in the shape the wire will carry
    expect(validate({ orderId: "o-1", quantity: 2 })).toBeOkWith({ orderId: "o-1", quantity: 2 });
  });

  it("rejects a payload the wire should never carry", ({ validate }) => {
    // GIVEN the same schema

    // WHEN the quantity arrives as a string, the way an untyped publisher sends it
    // THEN it is rejected as a value, naming the field — the contract is
    // executable, not documentation, and a caller can run it
    expect(validate({ orderId: "o-1", quantity: "two" })).toBeErrWith([
      expect.objectContaining({ path: ["quantity"] }),
    ]);
  });
});
