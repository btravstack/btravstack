import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("orderContract", () => {
  it("validates a workflow input from the contract alone", ({ validate }) => {
    // GIVEN the contract's own schema, and nothing else — no worker, no
    // connection, no activity implementation

    // WHEN a caller checks the payload it is about to start a workflow with
    // THEN it is accepted, in the shape Temporal will persist in the history
    expect(
      validate({
        tenantId: "0199a1e0-0000-7000-8000-000000009000",
        orderId: "0199a1e0-0000-7000-8000-000000000001",
        quantity: 2,
      }),
    ).toBeOkWith({
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      orderId: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 2,
    });
  });

  it("rejects a payload the contract does not describe", ({ validate }) => {
    // GIVEN the same schema

    // WHEN the quantity arrives as a string, the way an untyped caller sends it
    // THEN the issues come back as a value, naming the field — the contract is
    // executable, not documentation, and a client can run it
    expect(
      validate({
        tenantId: "0199a1e0-0000-7000-8000-000000009000",
        orderId: "0199a1e0-0000-7000-8000-000000000001",
        quantity: "2",
      }),
    ).toBeErrWith([expect.objectContaining({ path: ["quantity"] })]);
  });

  it("validates the second workflow's input too — a different vertical, on the same queue", ({
    validateCharge,
  }) => {
    // GIVEN the billing workflow's own schema, and nothing else

    // WHEN a caller checks the payload it is about to start `chargeOrder` with
    // THEN it is accepted, proving the contract holds more than one workflow
    expect(
      validateCharge({
        tenantId: "0199a1e0-0000-7000-8000-000000009000",
        orderId: "0199a1e0-0000-7000-8000-000000000001",
        amount: 42,
      }),
    ).toBeOkWith({
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      orderId: "0199a1e0-0000-7000-8000-000000000001",
      amount: 42,
    });
  });

  it("accepts a placement task scheduled before it named an operation", ({ validatePlace }) => {
    // GIVEN a `place` input in the shape the previous workflow version
    // scheduled — no `operationId`
    const legacy = {
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      orderId: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 2,
    };

    // WHEN a worker on this contract validates it
    // THEN it is accepted, so an in-flight fulfillment survives the deploy
    expect(validatePlace(legacy)).toBeOkWith(legacy);
  });

  it("preserves the originating operation on a cancellation task", ({ validateCancel }) => {
    // GIVEN compensation naming the run that placed the order
    const input = {
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      orderId: "0199a1e0-0000-7000-8000-000000000001",
      operationId: "original-run",
    };
    // WHEN the activity input crosses the contract boundary
    // THEN validation preserves the guard the repository needs
    expect(validateCancel(input)).toBeOkWith(input);
  });

  it("accepts a cancellation task scheduled before it named an operation", ({ validateCancel }) => {
    // GIVEN the input a previous workflow version scheduled
    const input = {
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      orderId: "0199a1e0-0000-7000-8000-000000000001",
    };
    // WHEN the new worker validates an in-flight task
    // THEN it remains accepted
    expect(validateCancel(input)).toBeOkWith(input);
  });

  it("refuses an id that is not a UUIDv7", ({ validate }) => {
    // GIVEN a payload whose order id is a plain string, not the contract's UUIDv7 shape
    const input = {
      tenantId: "0199a1e0-0000-7000-8000-000000009000",
      orderId: "o-1",
      quantity: 2,
    };

    // WHEN it is validated against the contract
    const result = validate(input);

    // THEN it is refused, naming the order id — proving the schema, not the
    // tenant, is what caught it
    expect(result).toBeErrWith([expect.objectContaining({ path: ["orderId"] })]);
  });
});
