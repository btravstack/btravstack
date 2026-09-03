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
 *
 * Each call takes the `idempotencyKey` the contract derives from the activity's
 * input. A real gateway is where that key does its work — it collapses a retry
 * into the first attempt — so a stand-in that dropped it would teach the wrong
 * shape; this one logs it, which is what an anti-corruption boundary with
 * nothing behind it can honestly do.
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
          authorize: (orderId, amount, idempotencyKey) => {
            authorized.add(1);
            logger.info("authorized the payment", { orderId, amount, idempotencyKey });
            return OkAsync(`auth-${orderId}`);
          },
          capture: (authorizationId, idempotencyKey) => {
            logger.info("captured the payment", { authorizationId, idempotencyKey });
            return OkAsync();
          },
          refund: (authorizationId, idempotencyKey) => {
            logger.info("refunded the payment", { authorizationId, idempotencyKey });
            return OkAsync();
          },
        };
      },
    }),
  ],
  exports: [PaymentService],
});
