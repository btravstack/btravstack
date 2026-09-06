import { Module, Provider } from "@btravstack/di";
import {
  CustomerRepository,
  OrderRepository,
  Outbox,
  Tenant,
} from "@btravstack/example-order-application";

import { OrderDatabase, OrderDatabaseModule } from "./database.js";
import { customerRepositoryProvider } from "./prisma-customer-repository.js";
import { prismaOrderRepository } from "./prisma-order-repository.js";
import { outboxProvider } from "./prisma-outbox.js";

/**
 * The orders repository, bound to the tenant of the unit it is built in.
 *
 * It is composed INSIDE a unit module — a request's, an activity attempt's, a
 * delivery's — and reads the one client the application scope holds through
 * `needs` rather than importing `OrderDatabaseModule`: an import would put the
 * database's providers in the fork's own tree, and a Prisma client would be
 * opened and closed per unit.
 */
export const OrderTenantPersistence = Module("OrderTenantPersistence")({
  needs: [Tenant, OrderDatabase],
  provides: [
    Provider(OrderRepository)({
      inject: { db: OrderDatabase, tenant: Tenant },
      sync: ({ db, tenant }) => prismaOrderRepository(db, tenant),
    }),
  ],
  exports: [OrderRepository],
});

/**
 * What the application scope holds: the outbox, whose relay sweeps across
 * tenants from outside any unit, and the database module itself — re-exported
 * so a unit forked over this scope can read the client that
 * `OrderTenantPersistence` binds a tenant to.
 */
export const OrderPersistenceModule = Module("OrderPersistence")({
  imports: [OrderDatabaseModule],
  provides: [outboxProvider],
  exports: [Outbox, OrderDatabaseModule],
});

/**
 * The customers vertical's adapter, importing the same `OrderDatabaseModule`
 * value. di flattens the module tree into a `Set` keyed by provider
 * **reference**, so a graph holding both persistence modules opens one
 * database, not two — the diamond that makes splitting the layer free.
 *
 * It stays in the application scope rather than moving into a unit: its port
 * names its tenant, because the procedures it serves are unmarked.
 */
export const CustomerPersistenceModule = Module("CustomerPersistence")({
  imports: [OrderDatabaseModule],
  provides: [customerRepositoryProvider],
  exports: [CustomerRepository],
});
