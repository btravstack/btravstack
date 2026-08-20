import { Module, Provider } from "@btravstack/di";
import { PaymentService } from "@btravstack/example-order-application";
import { Logger } from "@btravstack/observability";
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
  provides: [
    Provider(PaymentService)(
      { logger: Logger },
      {
        sync: ({ logger }) => ({
          authorize: (orderId, amount) => {
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
        }),
      },
    ),
  ],
  exports: [PaymentService],
});
