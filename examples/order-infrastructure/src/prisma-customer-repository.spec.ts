import { Module } from "@btravstack/di";
import { CustomerRepository } from "@btravstack/example-order-application";
import { describe, expect } from "vitest";

import { CustomerPersistenceModule } from "./index.js";
import { it } from "./test-fixtures.js";

describe("the Prisma CustomerRepository", () => {
  it("reads a stored row back as the domain's entity", async ({ customers, aCustomer }) => {
    // GIVEN a customer in the table
    await aCustomer("c-1", "Ada");

    // WHEN it is read back
    const found = await customers.find("c-1");

    // THEN what leaves the adapter is the entity, not the row and not the wire
    // shape — the conversion to `CustomerView` happens two layers out
    expect(found).toBeOkWith({ id: "c-1", name: "Ada" });
  });

  it("returns the domain's CustomerNotFound for an unknown id", async ({ customers }) => {
    // GIVEN an empty table
    // WHEN an unknown id is looked up
    // THEN absence is the one thing `find` reports as an error
    await expect(customers.find("missing")).toBeErrTagged("CustomerNotFound", { id: "missing" });
  });
});

describe("CustomerPersistenceModule", () => {
  it("satisfies the application's CustomerRepository need inside a scope", async () => {
    // GIVEN the module the composition root imports
    // WHEN a scope is opened over it and the port is asked about a customer
    // that scope's own fresh database does not hold
    const result = await Module.scoped(CustomerPersistenceModule, (ctx) =>
      ctx.get(CustomerRepository).find("c-absent"),
    );

    // THEN the port resolved to a working repository: the answer is the
    // domain's modeled absence, which means the query ran against a migrated
    // table rather than defecting on a missing one
    expect(result).toBeErrTagged("CustomerNotFound", { id: "c-absent" });
  });
});
