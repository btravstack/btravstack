import { Module } from "@btravstack/di";
import { CustomerRepository, OrderRepository, Outbox } from "@btravstack/example-order-application";
import { prismaTracing } from "@btravstack/prisma/otel";

import { OrderDatabaseModule } from "./database.js";

/**
 * ONE instance, shared by both persistence modules. `prismaTracing()` mints a
 * provider on a module-level port, so calling it twice is di's
 * duplicate-provider defect at build; `flatten` keys on provider REFERENCE, so
 * one instance imported twice is a diamond it collapses.
 */
const DatabaseTracing = prismaTracing();
import { customerRepositoryProvider } from "./prisma-customer-repository.js";
import { orderRepositoryProvider } from "./prisma-order-repository.js";
import { outboxProvider } from "./prisma-outbox.js";

/**
 * The one connection, shared by the two persistence modules without either
 * owning it. **Not** re-exported from this package's `index.ts`:
 * `OrderDatabase` crosses this file's boundary and no further.
 *
 * `@btravstack/prisma` supplies the whole module — the config provider, the
 * resourceful provider whose `release` closes the pool, and the per-query count
 * and error line — so there is nothing to declare here. `prismaTracing()` adds
 * Prisma's OWN OpenTelemetry instrumentation beside it, which traces at the
 * engine level: the real SQL, the connection acquisition. That is why the
 * starter emits no span of its own — it would be a shallower duplicate. Every importer still carries the
 * `Scope` need only `Module.scoped` discharges, and the `Env`, `Logger`,
 * `Meter` and `Tracer` the starter reads.
 */

/**
 * The other half of `OrderApplicationModule`'s gate: this module provides the
 * ports the orders vertical leaves open, so importing both is what makes
 * `Module.scoped` compile.
 *
 * `OrderDatabaseModule` is imported and **not re-exported** — di's `exports` are
 * declared, never inherited — so a consumer gets `OrderRepository` and `Outbox`
 * and no way to reach the Prisma client behind them.
 */
export const OrderPersistenceModule = Module("OrderPersistence")({
  imports: [OrderDatabaseModule, DatabaseTracing],
  provides: [orderRepositoryProvider, outboxProvider],
  exports: [OrderRepository, Outbox],
});

/**
 * The customers vertical's adapter, importing the same `OrderDatabaseModule`
 * value. di flattens the module tree into a `Set` keyed by provider
 * **reference**, so a graph holding both persistence modules opens one
 * database, not two — the diamond that makes splitting the layer free.
 */
export const CustomerPersistenceModule = Module("CustomerPersistence")({
  imports: [OrderDatabaseModule, DatabaseTracing],
  provides: [customerRepositoryProvider],
  exports: [CustomerRepository],
});
