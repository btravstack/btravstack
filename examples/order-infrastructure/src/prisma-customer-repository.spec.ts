import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { CustomerRepository } from "@btravstack/example-order-application";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { describe, expect, inject } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { CustomerPersistenceModule } from "./index.js";

/** The persistence module plus the environment the kernel would otherwise provide — see `prisma-order-repository.spec.ts`. */
const scopedCustomers = () =>
  Module("ScopedCustomers")({
    imports: [CustomerPersistenceModule, observability(), otel()],
    provides: [Provider(Env)({ value: { DATABASE_URL: inject("__ORDERS_DATABASE_URL__") } })],
    exports: [CustomerRepository],
  });

describe("the Prisma CustomerRepository", () => {
  it("reads a stored row back as the domain's entity", async ({ tenant, customers, aCustomer }) => {
    // GIVEN a customer in this test's own tenant
    await aCustomer("0199a1e0-0000-7000-8000-0000000000c1", "Ada");

    // WHEN it is read back
    const found = await customers.find(tenant, "0199a1e0-0000-7000-8000-0000000000c1");

    // THEN what leaves the adapter is the entity, not the row and not the wire
    // shape — the conversion to `CustomerView` happens two layers out
    expect(found).toBeOkWith({ id: "0199a1e0-0000-7000-8000-0000000000c1", name: "Ada" });
  });

  it("returns the domain's CustomerNotFound for an unknown id", async ({ tenant, customers }) => {
    // GIVEN a tenant with nobody in it
    // WHEN an unknown id is looked up
    // THEN absence is the one thing `find` reports as an error
    await expect(customers.find(tenant, "missing")).toBeErrTagged("CustomerNotFound", {
      id: "missing",
    });
  });

  it("does not read another tenant's customer", async ({ tenant, customers, db }) => {
    // GIVEN a customer registered under somebody else's tenant
    await db.customer.create({
      data: { tenantId: `${tenant}-other`, customerId: "c-theirs", name: "Grace" },
    });

    // WHEN this tenant looks for them
    const found = await customers.find(tenant, "c-theirs");

    // THEN they do not exist as far as this tenant is concerned
    expect(found).toBeErrTagged("CustomerNotFound", { id: "c-theirs" });
  });
});

describe("CustomerPersistenceModule", () => {
  it("satisfies the application's CustomerRepository need inside a scope", async ({ tenant }) => {
    // GIVEN the module the composition root imports, plus the environment the
    // kernel would otherwise provide
    // WHEN a scope is opened over it and the port is asked about a customer
    // this tenant does not hold
    const result = await Module.scoped(scopedCustomers(), (ctx) =>
      ctx.get(CustomerRepository).find(tenant, "c-absent"),
    );

    // THEN the port resolved to a working repository: the answer is the
    // domain's modeled absence, which means the query ran against a migrated
    // table rather than defecting on a missing one
    expect(result).toBeErrTagged("CustomerNotFound", { id: "c-absent" });
  });
});
