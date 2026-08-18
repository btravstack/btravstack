import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("orderContract", () => {
  it("validates a workflow input from the contract alone", ({ validate }) => {
    // GIVEN the contract's own schema, and nothing else — no worker, no
    // connection, no activity implementation

    // WHEN a caller checks the payload it is about to start a workflow with
    // THEN it is accepted, in the shape Temporal will persist in the history
    expect(validate({ tenantId: "acme", orderId: "o-1", quantity: 2 })).toBeOkWith({
      tenantId: "acme",
      orderId: "o-1",
      quantity: 2,
    });
  });

  it("rejects a payload the contract does not describe", ({ validate }) => {
    // GIVEN the same schema

    // WHEN the quantity arrives as a string, the way an untyped caller sends it
    // THEN the issues come back as a value, naming the field — the contract is
    // executable, not documentation, and a client can run it
    expect(validate({ tenantId: "acme", orderId: "o-1", quantity: "2" })).toBeErrWith([
      expect.objectContaining({ path: ["quantity"] }),
    ]);
  });

  it("validates the second workflow's input too — a different vertical, on the same queue", ({
    validateCharge,
  }) => {
    // GIVEN the billing workflow's own schema, and nothing else

    // WHEN a caller checks the payload it is about to start `chargeOrder` with
    // THEN it is accepted, proving the contract holds more than one workflow
    expect(validateCharge({ tenantId: "acme", orderId: "o-1", amount: 42 })).toBeOkWith({
      tenantId: "acme",
      orderId: "o-1",
      amount: 42,
    });
  });
});
