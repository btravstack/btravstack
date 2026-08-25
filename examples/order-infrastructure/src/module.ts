import { Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { CustomerRepository, OrderRepository, Outbox } from "@btravstack/example-order-application";

import { OrderDatabase, databaseConfig, orderDatabaseProvider } from "./database.js";
import { customerRepositoryProvider } from "./prisma-customer-repository.js";
import { orderRepositoryProvider } from "./prisma-order-repository.js";
import { outboxProvider } from "./prisma-outbox.js";

/**
 * The one connection, as a module of its own so the two persistence modules can
 * share it without either owning it. **Not** exported from this package's
 * `index.ts`: `OrderDatabase` crosses this file's boundary and no further.
 *
 * Its provider takes di's `acquire`/`release` arm, so every importer carries a
 * `Scope` need only `Module.scoped` discharges. The feature that reads the
 * environment is the one that declares it, and the only one — importers inherit
 * the obligation without restating it.
 */
const DatabaseModule = Module("Database")({
  needs: [Env],
  provides: [databaseConfig, orderDatabaseProvider],
  exports: [OrderDatabase],
});

/**
 * The other half of `OrderApplicationModule`'s gate: this module provides the
 * ports the orders vertical leaves open, so importing both is what makes
 * `Module.scoped` compile.
 *
 * `DatabaseModule` is imported and **not re-exported** — di's `exports` are
 * declared, never inherited — so a consumer gets `OrderRepository` and `Outbox`
 * and no way to reach the Prisma client behind them.
 */
export const OrderPersistenceModule = Module("OrderPersistence")({
  imports: [DatabaseModule],
  provides: [orderRepositoryProvider, outboxProvider],
  exports: [OrderRepository, Outbox],
});

/**
 * The customers vertical's adapter, importing the same `DatabaseModule`
 * value. di flattens the module tree into a `Set` keyed by provider
 * **reference**, so a graph holding both persistence modules opens one
 * database, not two — the diamond that makes splitting the layer free.
 */
export const CustomerPersistenceModule = Module("CustomerPersistence")({
  imports: [DatabaseModule],
  provides: [customerRepositoryProvider],
  exports: [CustomerRepository],
});
