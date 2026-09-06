import { Logger } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import {
  OrderApplicationModule,
  OrderRepository,
  PlaceOrder,
  Tenant,
} from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { OrderDatabase, OrderTenantPersistence } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { UnitSpanModule } from "@btravstack/observability/otel";
import { ActivityInput } from "@btravstack/temporal-worker";

/**
 * The module the worker forks around every activity attempt, seeded with the
 * validated input on `ActivityInput(orderContract)`.
 *
 * The contract declares `tenantId` on every workflow's arguments, so the
 * attempt itself is where the tenant comes from — and claiming the brand here
 * is what stops every activity claiming it again. The orders vertical is
 * composed over it, so an activity reads `PlaceOrder` and `OrderRepository`
 * off `context.unit` already bound to the attempt's tenant.
 *
 * `OrderTenantPersistence` reads `OrderDatabase` out of the application scope
 * rather than importing the database module: one Prisma client per process,
 * not one per attempt. `UnitSpanModule` rides along, so the span still wraps
 * the whole attempt.
 */
export const ActivityUnitModule = Module("ActivityUnit")({
  needs: [ActivityInput(orderContract), OrderDatabase, Logger],
  imports: [UnitSpanModule, OrderTenantPersistence, OrderApplicationModule],
  provides: [
    Provider(Tenant)({
      inject: { input: ActivityInput(orderContract) },
      sync: ({ input }) => TenantId(input.tenantId),
    }),
  ],
  exports: [Tenant, PlaceOrder, OrderRepository],
});
