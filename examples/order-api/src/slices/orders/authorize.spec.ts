import { TenantId } from "@btravstack/example-order-domain";
import { describe, expect } from "vitest";

import { it } from "../../__tests__/test-fixtures.js";
import { exportable, USER_EXPORT_CEILING } from "./authorize.js";

describe("exportable", () => {
  it("admits a service caller whatever the order weighs", ({ anOrderOf, tenant }) => {
    // GIVEN an order far over the ceiling a user is held to
    const order = anOrderOf(USER_EXPORT_CEILING * 10);

    // WHEN a machine caller asks for it
    const decided = exportable(
      { scheme: "service", identity: { appId: "reporting", tenantId: TenantId(tenant) } },
      order,
    );

    // THEN bulk is what a reporting job is for
    expect(decided).toBeOkWith(order);
  });

  it("admits a user for an order at the ceiling", ({ anOrderOf, tenant }) => {
    // GIVEN an order exactly at the ceiling
    const order = anOrderOf(USER_EXPORT_CEILING);

    // WHEN a user asks for it
    const decided = exportable(
      { scheme: "user", identity: { userId: "u-1", tenantId: TenantId(tenant) } },
      order,
    );

    // THEN the bound is inclusive
    expect(decided).toBeOkWith(order);
  });

  it("refuses a user above the ceiling, naming the reason", ({ anOrderOf, tenant }) => {
    // GIVEN an order one item over the ceiling
    const order = anOrderOf(USER_EXPORT_CEILING + 1);

    // WHEN a user asks for it
    const decided = exportable(
      { scheme: "user", identity: { userId: "u-1", tenantId: TenantId(tenant) } },
      order,
    );

    // THEN the refusal names which order and why, in the application's own words
    expect(decided).toBeErrWith(
      expect.objectContaining({
        _tag: "Forbidden",
        id: order.id,
        reason: expect.stringContaining("service"),
      }),
    );
  });
});
