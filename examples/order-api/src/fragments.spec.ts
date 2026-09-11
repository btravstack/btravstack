import request from "supertest";
import { describe, expect } from "vitest";

import { LOGIN, it } from "./__tests__/test-fixtures.js";

describe("order-api fragments", () => {
  it(
    "renders the order row to a browser holding the session its login sealed",
    async ({ serve, browser, clientWith, tokenFor, originFor, orderId, api }) => {
      // GIVEN a browser logged in through the provider, and an order placed
      // under that browser's own tenant through the JSON API
      const app = serve(api);
      const { cookie, tenant } = await browser(app);
      const client = await clientWith(app, `Bearer ${await tokenFor({ tenant })}`);
      await client.orders.place({ id: orderId, quantity: 2 });

      // WHEN the fragment route is requested with the cookie and nothing else —
      // the route's own path names only `id`, and the tenant comes off the session
      const response = await request(await originFor(app))
        .get(`/orders/${orderId}/row`)
        .set("cookie", cookie);

      // THEN the rendered row carries the order, over a plain HTML response
      expect({ status: response.status, body: response.text }).toEqual({
        status: 200,
        body: `<tr id="order-${orderId}"><td>2</td></tr>`,
      });
    },
    LOGIN,
  );

  it(
    "renders the slice's own not-found row to a browser whose tenant never placed that order",
    async ({ serve, browser, clientWith, tokenFor, otherTenant, originFor, orderId, api }) => {
      // GIVEN an order placed under a tenant that is not the browser's
      const app = serve(api);
      const owner = await clientWith(app, `Bearer ${await tokenFor({ tenant: otherTenant })}`);
      await owner.orders.place({ id: orderId, quantity: 1 });

      // WHEN a browser logged in as a different tenant requests the same id
      const { cookie } = await browser(app);
      const response = await request(await originFor(app))
        .get(`/orders/${orderId}/row`)
        .set("cookie", cookie);

      // THEN the slice's own triage rendered the not-found row, not the owner's order
      expect(response.text).toBe("<tr><td>not found</td></tr>");
    },
    LOGIN,
  );

  it("sends a browser with no session to the login route, carrying where it was going", async ({
    serve,
    originFor,
    orderId,
    api,
  }) => {
    // GIVEN the real root, and a browser that never logged in
    const app = serve(api);

    // WHEN it navigates to a fragment route
    const response = await request(await originFor(app)).get(`/orders/${orderId}/row`);

    // THEN it is sent to the login route `fragmentsLogin` names, with the
    // path it asked for as `return` — a 303, never a bare 401 to a person
    expect({ status: response.status, location: response.headers["location"] }).toEqual({
      status: 303,
      location: `/auth/login?return=${encodeURIComponent(`/orders/${orderId}/row`)}`,
    });
  });

  it("refuses a bearer token on the fragment route, which the session scheme alone serves", async ({
    serve,
    tokenFor,
    originFor,
    orderId,
    api,
  }) => {
    // GIVEN a valid `user` credential — what the JSON procedures take
    const app = serve(api);

    // WHEN it is presented to a route that requires `session`
    const response = await request(await originFor(app))
      .get(`/orders/${orderId}/row`)
      .set("authorization", `Bearer ${await tokenFor()}`);

    // THEN the route's `requires` is the scheme list, and `user` is not on it:
    // a browser route takes a cookie, and a token is not one
    expect(response.status).toBe(303);
  });
});
