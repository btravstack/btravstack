import { expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

it("serves the Pothos query and mutation beside the order API's other answerers", async ({
  serve,
  api,
  tokenFor,
  orderId,
}) => {
  // GIVEN the real order API and its bearer identity
  const app = serve(api);
  const info = (await app.runtimeInfo()).get();
  const token = await tokenFor();
  const request = (query: string, authorized: boolean) =>
    fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query }),
    });
  const mutation = `mutation { placeOrder(id: "${orderId}", quantity: 2) { id quantity } }`;

  // WHEN an anonymous caller is refused, and the user writes then reads an order
  const refused = await request(mutation, false);
  const placed = await request(mutation, true);
  const found = await request(`{ order(id: "${orderId}") { id quantity } }`, true);
  const duplicate = await request(mutation, true);

  // THEN the same tenant-bound use cases and GraphQL error boundary ran
  expect({
    refused: refused.status,
    placed: await placed.json(),
    found: await found.json(),
    duplicate: await duplicate.json(),
  }).toEqual({
    refused: 401,
    placed: { data: { placeOrder: { id: orderId, quantity: 2 } } },
    found: { data: { order: { id: orderId, quantity: 2 } } },
    duplicate: {
      errors: [expect.objectContaining({ extensions: { code: "CONFLICT" } })],
      data: { placeOrder: null },
    },
  });
});
