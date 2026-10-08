import { OrderGraphqlApi } from "@btravstack/example-order-graphql-api";
import { expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

it("serves GraphQL in a separate process backed by the oRPC API", async ({
  api,
  boot,
  env,
  orderId,
  serve,
  tokenFor,
}) => {
  // GIVEN the oRPC API and a separate GraphQL gateway that calls it
  const backend = serve(api);
  const backendPort = (await backend.runtimeInfo()).get()!.port;
  const gateway = boot(OrderGraphqlApi, {
    env: { ...env, ORDER_API_URL: `http://127.0.0.1:${backendPort}` },
  });
  const gatewayPort = (await gateway.runtimeInfo()).get()!.port;
  const token = await tokenFor();
  const request = (query: string, authorized: boolean) =>
    fetch(`http://127.0.0.1:${gatewayPort}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query }),
    });
  const mutation = `mutation { placeOrder(id: "${orderId}", quantity: 2) { id quantity } }`;

  // WHEN callers attempt an anonymous mutation, a valid mutation, a query and a duplicate
  const refused = await request(mutation, false);
  const placed = await request(mutation, true);
  const found = await request(`{ order(id: "${orderId}") { id quantity } }`, true);
  const duplicate = await request(mutation, true);

  // THEN the gateway preserves each contract outcome
  expect({
    refused: await refused.json(),
    placed: await placed.json(),
    found: await found.json(),
    duplicate: await duplicate.json(),
  }).toEqual({
    refused: {
      errors: [expect.objectContaining({ extensions: { code: "UNAUTHORIZED" } })],
      data: { placeOrder: null },
    },
    placed: { data: { placeOrder: { id: orderId, quantity: 2 } } },
    found: { data: { order: { id: orderId, quantity: 2 } } },
    duplicate: {
      errors: [expect.objectContaining({ extensions: { code: "CONFLICT" } })],
      data: { placeOrder: null },
    },
  });
});
