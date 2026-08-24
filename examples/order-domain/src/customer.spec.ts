import { describe, expect } from "vitest";

import { Customer, CustomerNotFound, type CustomerId } from "./index.js";
import { it } from "./test-fixtures.js";

describe("Customer", () => {
  it("constructs a real entity, not the wire shape under another name", ({ customer }) => {
    // GIVEN a customer built from the fields an adapter reads off a row
    // WHEN it is read back
    // THEN it is the entity itself. `constructor` is read through the prototype
    // chain, so the class is pinned inside the one assertion
    expect(customer).toEqual(
      expect.objectContaining({
        constructor: Customer,
        id: "0199a1e0-0000-7000-8000-0000000000c1",
        name: "Ada",
      }),
    );
  });

  it("refuses to patch the immutable id, even when it is smuggled past the type", ({
    customer,
  }) => {
    // GIVEN a patch aimed at the immutable id
    // WHEN it is applied
    // THEN identity is settled at registration, and the entity says so as a value
    expect(customer.update({ id: "0199a1e0-0000-7000-8000-0000000000c2" } as never)).toBeErrTagged(
      "InvalidEntity",
    );
  });
});

describe("domain errors", () => {
  it("names the customer in a CustomerNotFound message", () => {
    // GIVEN the error, constructed with its payload
    // WHEN its message is read
    // THEN the customer it is about is named in it
    expect(
      new CustomerNotFound({ id: "0199a1e0-0000-7000-8000-0000000000c9" as CustomerId }).message,
    ).toBe("no customer with id 0199a1e0-0000-7000-8000-0000000000c9");
  });
});
