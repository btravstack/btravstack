import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

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
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      kind: "order",
      id: "0199a1e0-0000-7000-8000-000000000001",
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
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      kind: "order",
      id: "0199a1e0-0000-7000-8000-000000000001",
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
        tenantId: "0199a1e0-0000-7000-8000-000000009000",
        kind: "order",
        id: "0199a1e0-0000-7000-8000-000000000001",
        occurredAt: "2026-08-13T22:00:00.000Z",
        payload: { quantity: "two" },
      }),
    ).toBeErrWith([expect.objectContaining({ path: ["payload", "quantity"] })]);
  });

  it("refuses an id that is not a UUIDv7", ({ validate }) => {
    // GIVEN an event whose subject id is a plain string, not the wire's UUIDv7 shape
    const event = {
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      kind: "order",
      id: "o-1",
      occurredAt: "2026-08-13T22:00:00.000Z",
      payload: { quantity: 2 },
    };

    // WHEN a relay checks the envelope it is about to publish
    const result = validate(event);

    // THEN it is refused, naming the id field — proving the schema, not the
    // tenant, is what caught it
    expect(result).toBeErrWith([expect.objectContaining({ path: ["id"] })]);
  });
});
