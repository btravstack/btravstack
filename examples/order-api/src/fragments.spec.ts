import request from "supertest";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("order-api fragments", () => {
  it("renders the order row over the htmx answerer, tenanted off the caller's own credential", async ({
    serve,
    tenant,
    clientFor,
    originFor,
    api,
  }) => {
    // GIVEN an order placed through the real root, under this test's own tenant
    const app = serve(api);
    const client = await clientFor(app);
    await client.orders.place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 });

    // WHEN the fragment route is requested with a credential for that same
    // tenant — the route's own path names only `id`
    const response = await request(await originFor(app))
      .get("/orders/0199a1e0-0000-7000-8000-000000000001/row")
      .set("authorization", `Bearer ${tenant}:u-1`);

    // THEN the rendered row carries the order, over a plain HTML response
    expect({ status: response.status, body: response.text }).toEqual({
      status: 200,
      body: '<tr id="order-0199a1e0-0000-7000-8000-000000000001"><td>2</td></tr>',
    });
  });

  it("renders the slice's own not-found row for a caller whose tenant never placed that order", async ({
    serve,
    tenant,
    clientWith,
    originFor,
    api,
  }) => {
    // GIVEN an order placed under one tenant
    const app = serve(api);
    const owner = await clientWith(app, `Bearer ${tenant}:u-1`);
    await owner.orders.place({ id: "0199a1e0-0000-7000-8000-000000000002", quantity: 1 });

    // WHEN a different tenant's credential requests the same id — the route
    // names only `id`, so the tenant comes off the caller's own principal
    const response = await request(await originFor(app))
      .get("/orders/0199a1e0-0000-7000-8000-000000000002/row")
      .set("authorization", `Bearer ${tenant}-other:u-2`);

    // THEN the slice's own triage rendered the not-found row, not the owner's order
    expect(response.text).toBe("<tr><td>not found</td></tr>");
  });
});
