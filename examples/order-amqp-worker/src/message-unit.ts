import { AmqpMessage } from "@btravstack/amqp-worker";
import { Module, Provider } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Tenant } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { UnitSpanModule } from "@btravstack/observability/otel";

/**
 * The module the worker forks around every delivery, seeded with the validated
 * message on `AmqpMessage(orderContract)`.
 *
 * The envelope carries `tenantId` because the CONTRACT declares it — the
 * starter knows nothing about tenants — so this is where it is claimed, once,
 * and both handlers read `context.unit.tenant` instead of destructuring the
 * payload again. `UnitSpanModule` rides along, so the span still wraps the
 * whole delivery.
 *
 * No vertical is composed here: a subscriber reacts to a fact somebody else
 * committed, so nothing in this deployment places an order off a message.
 */
export const MessageUnitModule = Module("MessageUnit")({
  needs: [AmqpMessage(orderContract)],
  imports: [UnitSpanModule],
  provides: [
    Provider(Tenant)({
      inject: { message: AmqpMessage(orderContract) },
      sync: ({ message }) => TenantId(message.payload.tenantId),
    }),
  ],
  exports: [Tenant],
});
