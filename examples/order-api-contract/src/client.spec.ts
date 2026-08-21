import { ORPCError } from "@orpc/client";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("contract", () => {
  it("types and carries a call made by a client built from the contract alone", async ({
    client,
  }) => {
    // GIVEN a client whose types come from the contract and whose transport is
    // a stub — no router, no `@orpc/server`, no composition root

    // WHEN a procedure the contract declares is called
    // THEN the contract's own output shape comes back as a value
    await expect(
      client.orders.place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 }),
    ).toBeOkWith({
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 2,
    });
  });

  it("hands a declared error back to that client as a typed value", async ({ client }) => {
    // GIVEN the same client, and an order the stub does not hold

    // WHEN it is looked up
    const missing = await client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000404" });

    // THEN the code and payload the contract declares arrive on the error
    // channel, inferable — the half of contract-first design a client is
    // buying, and it needed nothing from the implementation package
    expect(missing).toBeErrWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "NOT_FOUND",
        data: { id: "0199a1e0-0000-7000-8000-000000000404" },
        inferable: true,
      }),
    );
  });
});
