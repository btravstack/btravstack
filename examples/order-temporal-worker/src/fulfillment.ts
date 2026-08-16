import { currentUnit } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { ShippingService, StockService } from "@btravstack/example-order-application";
import { Logger } from "@btravstack/observability";
import { OkAsync, fromSafePromise } from "unthrown";

/**
 * The two external services the saga orchestrates, as in-memory stand-ins. In
 * a real system each is another team's API behind an anti-corruption boundary;
 * here they always say yes and leave a log line, because what this deployment
 * demonstrates is the *orchestration* — the specs swap in providers that say
 * no, which is where the compensation paths run.
 *
 * A module of its own so the swap is one import: the composition root takes
 * `FulfillmentModule`, a spec takes its own failing twin, and
 * `OrderApplicationModule` — which owns the ports — never knows the difference.
 *
 * `arrange` honours the kernel's deadline, and an adapter is where reading the
 * ambient record is legitimate (thesis 2: it carries data about this unit, and
 * a service is never in it). `currentUnit()?.signal` is aborted once the drain
 * has run out of time, and an outbound call whose answer nobody in this
 * process will read is not worth starting: the activity attempt fails as a
 * **defect**, which the platform retries on another worker — the right shape
 * for "we ran out of time", where the contract's `ShippingUnavailable` is a
 * permanent no. The signal arrives on the record rather than as a parameter
 * because the runtime is middleware-shaped: the kernel's work callback is
 * Temporal's `next()`, and an activity has none to receive it through.
 * Temporal's own `Context.current().cancellationSignal` is a different clock
 * — it fires on `shutdownGraceTime` — so the two are honoured together.
 */
export const FulfillmentModule = Module("Fulfillment")({
  provides: [
    Provider(StockService)([Logger], {
      sync: (logger) => ({
        reserve: (orderId, quantity) => {
          logger.info("reserved stock", { orderId, quantity });
          return OkAsync();
        },
        release: (orderId) => {
          logger.info("released the reservation", { orderId });
          return OkAsync();
        },
      }),
    }),
    Provider(ShippingService)([Logger], {
      sync: (logger) => ({
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
    }),
  ],
  exports: [StockService, ShippingService],
});
