import { Module, Provider } from "@btravstack/di";
import { Logger, ShippingService, StockService } from "@btravstack/start-example-order-application";
import { OkAsync } from "unthrown";

/**
 * The two external services the saga orchestrates, as in-memory stand-ins. In
 * a real system each is another team's API behind an anti-corruption boundary;
 * here they always say yes and leave a log line, because what this deployment
 * demonstrates is the *orchestration* — the specs swap in providers that say
 * no, which is where the compensation paths run.
 *
 * A module of its own so the swap is one import: the composition root takes
 * `FulfillmentModule`, a spec takes its own failing twin, and
 * `ApplicationModule` — which owns the ports — never knows the difference.
 */
export const FulfillmentModule = Module("Fulfillment")({
  provides: [
    Provider(StockService)([Logger], {
      sync: (logger) => ({
        reserve: (orderId, quantity) => {
          logger.info(`reserved ${quantity} items for order ${orderId}`);
          return OkAsync();
        },
        release: (orderId) => {
          logger.info(`released the reservation for order ${orderId}`);
          return OkAsync();
        },
      }),
    }),
    Provider(ShippingService)([Logger], {
      sync: (logger) => ({
        arrange: (orderId) => {
          logger.info(`arranged shipping for order ${orderId}`);
          return OkAsync();
        },
      }),
    }),
  ],
  exports: [StockService, ShippingService],
});
