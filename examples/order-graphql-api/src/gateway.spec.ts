import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("the order GraphQL gateway", () => {
  it("answers each field on its own, so a sibling's refusal costs the others nothing", async ({
    known,
    gateway,
    orderApi,
  }) => {
    // GIVEN one order the API holds
    orderApi.seed(known.placed);

    // WHEN one operation asks for it, for an order it does not hold, and for a malformed id
    const body = await gateway(
      `{ mine: order(id: "${known.placed.id}") { quantity } missing: order(id: "${known.missing}") { id } malformed: order(id: "nope") { id } }`,
    );

    // THEN each alias answers for itself: data, null, and a field-local refusal
    expect(body).toEqual({
      data: { mine: { quantity: 2 }, missing: null, malformed: null },
      errors: [
        expect.objectContaining({ path: ["malformed"], extensions: { code: "BAD_REQUEST" } }),
      ],
    });
  });

  it("fetches an order once however many fields ask for it", async ({
    known,
    gateway,
    orderApi,
  }) => {
    // GIVEN one order the API holds
    orderApi.seed(known.placed);

    // WHEN two aliases ask for it in one operation
    await gateway(
      `{ a: order(id: "${known.placed.id}") { id } b: order(id: "${known.placed.id}") { quantity } }`,
    );

    // THEN the API was called once
    expect(orderApi.calls).toEqual([`find:${known.placed.id}`]);
  });

  it("keeps the cache to the request it belongs to", async ({ known, gateway, orderApi }) => {
    // GIVEN one order the API holds
    orderApi.seed(known.placed);

    // WHEN two requests ask for it
    await gateway(`{ order(id: "${known.placed.id}") { id } }`);
    await gateway(`{ order(id: "${known.placed.id}") { id } }`);

    // THEN each request called the API itself
    expect(orderApi.calls).toEqual([`find:${known.placed.id}`, `find:${known.placed.id}`]);
  });

  it("reads a write back in the same operation, without calling the API again", async ({
    known,
    gateway,
    orderApi,
  }) => {
    // GIVEN an order nobody has placed yet

    // WHEN one mutation places it and reads it back through `query`
    const body = await gateway(
      `mutation { placeOrder(id: "${known.fresh}", quantity: 3) { query { order(id: "${known.fresh}") { quantity } } } }`,
    );

    // THEN the read saw the write, and only the write reached the API
    expect({ body, calls: orderApi.calls }).toEqual({
      body: { data: { placeOrder: { query: { order: { quantity: 3 } } } } },
      calls: [`place:${known.fresh}`],
    });
  });

  it("runs mutations in order, the second refused by the first's write", async ({
    known,
    gateway,
  }) => {
    // GIVEN an order nobody has placed yet

    // WHEN one operation places it twice
    const body = await gateway(
      `mutation { first: placeOrder(id: "${known.fresh}", quantity: 1) { order { id } } again: placeOrder(id: "${known.fresh}", quantity: 2) { order { id } } }`,
    );

    // THEN the first is data and the second is its own CONFLICT
    expect(body).toEqual({
      data: { first: { order: { id: known.fresh } }, again: null },
      errors: [expect.objectContaining({ path: ["again"], extensions: { code: "CONFLICT" } })],
    });
  });

  it("answers the API's own authentication refusal on the field", async ({ known, gateway }) => {
    // GIVEN a caller with no credentials, which the gateway itself does not check

    // WHEN it asks for an order
    const body = await gateway(`{ order(id: "${known.placed.id}") { id } }`, "none");

    // THEN the API's UNAUTHORIZED is that field's error
    expect(body).toEqual({
      data: { order: null },
      errors: [expect.objectContaining({ path: ["order"], extensions: { code: "UNAUTHORIZED" } })],
    });
  });

  it("masks a defect", async ({ known, gateway }) => {
    // GIVEN an order whose lookup fails inside the API

    // WHEN it is asked for
    const body = await gateway(`{ order(id: "${known.broken}") { id } }`);

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

  it("refuses an alias flood before any service is called", async ({
    known,
    gateway,
    orderApi,
  }) => {
    // GIVEN a mutation naming more aliases than the gateway allows
    const aliases = Array.from(
      { length: 11 },
      (_, index) =>
        `a${String(index)}: placeOrder(id: "${known.fresh}", quantity: 1) { order { id } }`,
    );

    // WHEN it is sent
    const body = await gateway(`mutation { ${aliases.join(" ")} }`);

    // THEN it is refused at validation, and nothing was placed
    expect({ body, calls: orderApi.calls }).toEqual({
      body: { errors: [expect.objectContaining({ extensions: { code: "TOO_MANY_ALIASES" } })] },
      calls: [],
    });
  });

  it("counts the aliases a fragment brings", async ({ known, gateway, orderApi }) => {
    // GIVEN a mutation whose aliases all arrive through a fragment
    const aliases = Array.from(
      { length: 11 },
      (_, index) =>
        `a${String(index)}: placeOrder(id: "${known.fresh}", quantity: 1) { order { id } }`,
    );

    // WHEN it is sent
    const body = await gateway(
      `mutation { ...Flood } fragment Flood on Mutation { ${aliases.join(" ")} }`,
    );

    // THEN it is refused like the inline flood, and nothing was placed
    expect({ body, calls: orderApi.calls }).toEqual({
      body: { errors: [expect.objectContaining({ extensions: { code: "TOO_MANY_ALIASES" } })] },
      calls: [],
    });
  });

  it("counts each operation of a document on its own", async ({ known, gateway, orderApi }) => {
    // GIVEN a document whose other operation is over the limit on its own
    orderApi.seed(known.placed);
    const several = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `o${String(index)}: order(id: "${known.placed.id}") { id }`,
      ).join(" ");

    // WHEN the smaller one is selected
    const body = await gateway(
      `query Small { ${several(4)} } query Large { ${several(11)} }`,
      "bearer",
      "Small",
    );

    // THEN it is answered
    expect(body).toEqual({
      data: {
        o0: { id: known.placed.id },
        o1: { id: known.placed.id },
        o2: { id: known.placed.id },
        o3: { id: known.placed.id },
      },
    });
  });
});
