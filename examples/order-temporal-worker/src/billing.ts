import { Logger, Meter } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { PaymentService } from "@btravstack/example-order-application";
import { OkAsync } from "unthrown";

/**
 * The payment provider, as an in-memory stand-in — another team's API behind
 * an anti-corruption boundary in a real system. A module of its own so the
 * swap is one import: the composition root takes `BillingModule`, a spec takes
 * a twin that declines, and `OrderApplicationModule` — which owns the port —
 * never knows the difference.
 *
 * It always says yes. What this deployment demonstrates is the orchestration;
 * the specs supply the refusing provider, which is where compensation runs.
 */
export const BillingModule = Module("Billing")({
  needs: [Logger, Meter],
  provides: [
    Provider(PaymentService)({
      inject: { logger: Logger, meter: Meter },
      sync: ({ logger, meter }) => {
        // Counted at the adapter, the seam metrics share with the logger.
        const authorized = meter.createCounter("btravstack.payments.authorized");
        return {
          authorize: (orderId, amount) => {
            authorized.add(1);
            logger.info("authorized the payment", { orderId, amount });
            return OkAsync(`auth-${orderId}`);
          },
          capture: (authorizationId) => {
            logger.info("captured the payment", { authorizationId });
            return OkAsync();
          },
          refund: (authorizationId) => {
            logger.info("refunded the payment", { authorizationId });
            return OkAsync();
          },
        };
      },
    }),
  ],
  exports: [PaymentService],
});
