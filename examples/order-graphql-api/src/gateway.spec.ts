import type { OrderView } from "@btravstack/example-order-api-contract";
import { describe, expect } from "vitest";

import { BROKEN, it } from "./test-fixtures.js";

const PLACED = "0199a1e0-0000-7000-8000-000000000001";
const NEW = "0199a1e0-0000-7000-8000-000000000002";
const MISSING = "0199a1e0-0000-7000-8000-000000000404";
const placed = { id: PLACED, quantity: 2 } as OrderView;

describe("the order GraphQL gateway", () => {
  it("answers each field on its own, so a sibling's refusal costs the others nothing", async ({
    gateway,
    orderApi,
  }) => {
    // GIVEN one order the API holds
    orderApi.seed(placed);

    // WHEN one operation asks for it, for an order it does not hold, and for a malformed id
    const body = await gateway(
      `{ mine: order(id: "${PLACED}") { quantity } missing: order(id: "${MISSING}") { id } malformed: order(id: "nope") { id } }`,
    );

    // THEN each alias answers for itself: data, null, and a field-local refusal
    expect(body).toEqual({
      data: { mine: { quantity: 2 }, missing: null, malformed: null },
      errors: [
        expect.objectContaining({ path: ["malformed"], extensions: { code: "BAD_REQUEST" } }),
      ],
    });
  });

  it("fetches an order once however many fields ask for it", async ({ gateway, orderApi }) => {
    // GIVEN one order the API holds
    orderApi.seed(placed);

    // WHEN two aliases ask for it in one operation
    await gateway(`{ a: order(id: "${PLACED}") { id } b: order(id: "${PLACED}") { quantity } }`);

    // THEN the API was called once
    expect(orderApi.calls).toEqual([`find:${PLACED}`]);
  });

  it("keeps the cache to the request it belongs to", async ({ gateway, orderApi }) => {
    // GIVEN one order the API holds
    orderApi.seed(placed);

    // WHEN two requests ask for it
    await gateway(`{ order(id: "${PLACED}") { id } }`);
    await gateway(`{ order(id: "${PLACED}") { id } }`);

    // THEN each request called the API itself
    expect(orderApi.calls).toEqual([`find:${PLACED}`, `find:${PLACED}`]);
  });

  it("reads a write back in the same operation, without calling the API again", async ({
    gateway,
    orderApi,
  }) => {
    // GIVEN an order nobody has placed yet

    // WHEN one mutation places it and reads it back through `query`
    const body = await gateway(
      `mutation { placeOrder(id: "${NEW}", quantity: 3) { query { order(id: "${NEW}") { quantity } } } }`,
    );

    // THEN the read saw the write, and only the write reached the API
    expect({ body, calls: orderApi.calls }).toEqual({
      body: { data: { placeOrder: { query: { order: { quantity: 3 } } } } },
      calls: [`place:${NEW}`],
    });
  });

  it("runs mutations in order, the second refused by the first's write", async ({ gateway }) => {
    // GIVEN an order nobody has placed yet

    // WHEN one operation places it twice
    const body = await gateway(
      `mutation { first: placeOrder(id: "${NEW}", quantity: 1) { order { id } } again: placeOrder(id: "${NEW}", quantity: 2) { order { id } } }`,
    );

    // THEN the first is data and the second is its own CONFLICT
    expect(body).toEqual({
      data: { first: { order: { id: NEW } }, again: null },
      errors: [expect.objectContaining({ path: ["again"], extensions: { code: "CONFLICT" } })],
    });
  });

  it("answers the API's own authentication refusal on the field", async ({ gateway }) => {
    // GIVEN a caller with no credentials, which the gateway itself does not check

    // WHEN it asks for an order
    const body = await gateway(`{ order(id: "${PLACED}") { id } }`, "none");

    // THEN the API's UNAUTHORIZED is that field's error
    expect(body).toEqual({
      data: { order: null },
      errors: [expect.objectContaining({ path: ["order"], extensions: { code: "UNAUTHORIZED" } })],
    });
  });

  it("masks a defect", async ({ gateway }) => {
    // GIVEN an order whose lookup fails inside the API

    // WHEN it is asked for
    const body = await gateway(`{ order(id: "${BROKEN}") { id } }`);

    // THEN the client sees the masked message, never the API's
    expect(body).toEqual({
      data: { order: null },
      errors: [
        expect.objectContaining({
          message: "Unexpected error.",
          path: ["order"],
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        }),
      ],
    });
  });

  it("refuses an alias flood before any service is called", async ({ gateway, orderApi }) => {
    // GIVEN a mutation naming more aliases than the gateway allows
    const aliases = Array.from(
      { length: 11 },
      (_, index) => `a${String(index)}: placeOrder(id: "${NEW}", quantity: 1) { order { id } }`,
    );

    // WHEN it is sent
    const body = await gateway(`mutation { ${aliases.join(" ")} }`);

    // THEN it is refused at validation, and nothing was placed
    expect({ body, calls: orderApi.calls }).toEqual({
      body: { errors: [expect.objectContaining({ extensions: { code: "TOO_MANY_ALIASES" } })] },
      calls: [],
    });
  });
});
