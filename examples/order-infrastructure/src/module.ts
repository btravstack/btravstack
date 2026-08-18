import { Module } from "@btravstack/di";
import { CustomerRepository, OrderRepository, Outbox } from "@btravstack/example-order-application";

import { OrderDatabase, databaseConfig, orderDatabaseProvider } from "./database.js";
import { customerRepositoryProvider } from "./prisma-customer-repository.js";
import { orderRepositoryProvider } from "./prisma-order-repository.js";
import { outboxProvider } from "./prisma-outbox.js";

/**
 * The one connection, as a module of its own so the two persistence modules
 * can share it without either owning it. It is **not** exported from this
 * package's `index.ts`: `OrderDatabase` crosses this file's boundary and no
 * further.
 *
 * Its provider takes di's `acquire`/`release` arm, so every module that
 * imports this one carries a `Scope` need, and only `Module.scoped`
 * discharges it. A composition root that forgets the scope does not compile.
 * `DATABASE_URL` is bound here rather than read anywhere: `databaseConfig`
 * is what puts `ConfigInvalid` in this module's error channel, and with it
 * every consumer's.
 */
const DatabaseModule = Module("Database")({
  provides: [databaseConfig, orderDatabaseProvider],
  exports: [OrderDatabase],
});

/**
 * The other half of `OrderApplicationModule`'s arity gate: this module
 * provides the ports the orders vertical leaves open, so importing both is
 * what makes `Module.scoped` compile.
 *
 * `DatabaseModule` is imported and **not re-exported** — di's `exports` are
 * declared, never inherited, so importing this module gives a consumer
 * `OrderRepository` and `Outbox` and no way to reach the Prisma client behind
 * them. That is the same privacy the single `PersistenceModule` had; sharing
 * the connection with the customers vertical did not spend it.
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
