import { Module } from "@btravstack/di";
import { CustomerRepository, OrderRepository, Outbox } from "@btravstack/example-order-application";

import { orderDatabaseProvider } from "./database.js";
import { customerRepositoryProvider } from "./prisma-customer-repository.js";
import { orderRepositoryProvider } from "./prisma-order-repository.js";
import { outboxProvider } from "./prisma-outbox.js";

/**
 * The other half of `ApplicationModule`'s arity gate: this module provides the
 * ports the application layer leaves open, so importing both is what makes
 * `Module.scoped` compile. It exports the two repositories and the outbox —
 * the Prisma client stays behind the boundary, and one connection serves every
 * vertical.
 *
 * Its database provider takes di's `acquire`/`release` arm, so the module also
 * carries a `Scope` need, and only `Module.scoped` discharges it. A composition
 * root that forgets the scope does not compile.
 */
export const PersistenceModule = Module("Persistence")({
  provides: [
    orderDatabaseProvider,
    orderRepositoryProvider,
    customerRepositoryProvider,
    outboxProvider,
  ],
  exports: [OrderRepository, CustomerRepository, Outbox],
});
