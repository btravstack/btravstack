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

  it("composes every route with the contract's shape and nearest-mark requirements, and wires the principal and params into handle", async ({
    htmx,
  }) => {
    // GIVEN the fragments composed into one port, with a "user" authenticator
    // discharging the scheme every route names
    const service = (await htmx.service()).get();
    const orderRow = service.routes.find((route) => route.path === "/orders/:id/row");
    assert.ok(orderRow !== undefined, "the orderRow route was not composed");
    const answered = (await orderRow.handle({ userId: "u-1" }, { id: "42" }, {})).get();

    // WHEN the composed service is inspected end to end
    // THEN every route carries the contract's own shape, an unmarked route
    // inherits the contract's mark, a marked one overrides it, and the piece's
    // handler received its principal and params through `handle`
    expect({
      routes: service.routes.map((route) => ({
        path: route.path,
        method: route.method,
        requirements: route.requirements,
      })),
      schemes: Object.keys(service.authenticators),
      answer: answered.value,
    }).toEqual({
      routes: [
        { path: "/orders/:id/row", method: "GET", requirements: [{ user: [] }] },
        { path: "/health", method: "GET", requirements: [{ user: [] }] },
        { path: "/admin", method: "GET", requirements: [{ user: ["admin"] }] },
      ],
      schemes: ["user"],
      answer: "<tr>hi u-1:42</tr>",
    });
  });
});
