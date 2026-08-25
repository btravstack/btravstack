import { currentUnit, Logger } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { ShippingService, StockService } from "@btravstack/example-order-application";
import { OkAsync, fromSafePromise } from "unthrown";

/**
 * The two external services the saga orchestrates, as in-memory stand-ins that
 * always say yes: what this deployment demonstrates is the ORCHESTRATION, and
 * the specs swap in providers that say no, which is where compensation runs.
 *
 * A module of its own so that swap is one import, and `OrderApplicationModule`
 * — which owns the ports — never knows the difference.
 *
 * `arrange` honours the kernel's deadline, and an adapter is where reading the
 * ambient record is legitimate. An outbound call whose answer nobody in this
 * process will read is not worth starting, so the attempt fails as a **defect**,
 * which the platform retries on another worker — the right shape for "we ran out
 * of time", where `ShippingUnavailable` is a permanent no.
 */
export const FulfillmentModule = Module("Fulfillment")({
  needs: [Logger],
  provides: [
    Provider(StockService)(
      { logger: Logger },
      {
        sync: ({ logger }) => ({
          reserve: (orderId, quantity) => {
            logger.info("reserved stock", { orderId, quantity });
            return OkAsync();
          },
          release: (orderId) => {
            logger.info("released the reservation", { orderId });
            return OkAsync();
          },
        }),
      },
    ),
    Provider(ShippingService)(
      { logger: Logger },
      {
        sync: ({ logger }) => ({
          arrange: (orderId) =>
            currentUnit()?.signal.aborted === true
              ? fromSafePromise(
                  Promise.reject(
                    new Error(
                      `the drain deadline passed before shipping for ${orderId} was arranged`,
                    ),
                  ),
                )
              : (logger.info("arranged shipping", { orderId }), OkAsync()),
        }),
      },
    ),
  ],
  exports: [StockService, ShippingService],
});
