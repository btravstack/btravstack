import assert from "node:assert/strict";

import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("HtmxFragments", () => {
  it("carries the port its route key minted, and the deps it declared", async ({ htmx }) => {
    // GIVEN a piece minted from the fragments contract and one of its keys
    const { orderRowFragment } = htmx;

    // WHEN the provider is inspected
    // THEN its port id carries the FRAGMENT_PREFIX and the key, next to the
    // deps it declared
    expect({
      portId: orderRowFragment.port.portId,
      deps: orderRowFragment.deps.map((dep) => dep.portId),
    }).toEqual({ portId: "HtmxFragment:orderRow", deps: ["Greeter"] });
  });

  it("composes every route with the contract's shape and nearest-mark requirements, resolving each scheme to its own authenticator", async ({
    htmx,
  }) => {
    // GIVEN the fragments composed into one port over two schemes — "user"
    // from the contract's own mark, "service" from a route overriding it
    const composed = (await htmx.service()).get();
    const userAuth = composed.authenticators["user"];
    const serviceAuth = composed.authenticators["service"];
    assert.ok(userAuth !== undefined, 'no authenticator resolved for "user"');
    assert.ok(serviceAuth !== undefined, 'no authenticator resolved for "service"');
    const [user, service] = await Promise.all([userAuth({}), serviceAuth({})]);

    // WHEN the composed service is inspected end to end
    // THEN every route carries the contract's own shape, an unmarked route
    // inherits the contract's mark, a marked one overrides it with its own
    // scheme, and each scheme key resolves to ITS OWN authenticator rather
    // than to a mismatched or missing one
    expect({
      routes: composed.routes.map((route) => ({
        path: route.path,
        method: route.method,
        requirements: route.requirements,
      })),
      user: user.getOrThrow(),
      service: service.getOrThrow(),
    }).toEqual({
      routes: [
        { path: "/orders/:id/row", method: "GET", requirements: [{ user: [] }] },
        { path: "/health", method: "GET", requirements: [{ user: [] }] },
        { path: "/admin", method: "GET", requirements: [{ service: [] }] },
      ],
      user: { userId: "u-1" },
      service: { appId: "a-1" },
    });
  });

  it("wires a route's principal and params into its own piece's handler through handle", async ({
    htmx,
  }) => {
    // GIVEN the fragments composed into one port, with orderRow's own handler
    // reading its principal and path parameter
    const composed = (await htmx.service()).get();
    const orderRow = composed.routes.find((route) => route.path === "/orders/:id/row");
    assert.ok(orderRow !== undefined, "the orderRow route was not composed");

    // WHEN its handler is called through `handle`
    const answered = (await orderRow.handle({ userId: "u-1" }, { id: "42" }, {})).get();

    // THEN it received both, exactly as the piece's own function reads them
    expect(answered.value).toBe("<tr>hi u-1:42</tr>");
  });
});
