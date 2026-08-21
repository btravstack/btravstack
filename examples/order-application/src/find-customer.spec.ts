import { Module } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";
import { describe, expect } from "vitest";

import { FindCustomer } from "./index.js";
import { it } from "./test-fixtures.js";

describe("FindCustomer", () => {
  it("returns the entity the repository holds, never a wire shape", async ({ testModule }) => {
    // GIVEN the application wired over an in-memory repository
    // WHEN a customer it holds is looked up
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(FindCustomer).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-0000000000c1"),
    );

    // THEN the use case answers with the domain's own entity — converting it
    // for a transport is the controller's job, one layer out
    expect(result).toBeOkWith({ id: "0199a1e0-0000-7000-8000-0000000000c1", name: "Ada" });
  });

  it("returns CustomerNotFound for an unknown id", async ({ testModule }) => {
    // GIVEN the same repository
    // WHEN an id nobody registered is looked up
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(FindCustomer).execute(TenantId("acme"), "missing"),
    );

    // THEN absence is a modeled error, not an empty success
    expect(result).toBeErrTagged("CustomerNotFound", { id: "missing" });
  });
});
