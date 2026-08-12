import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

/**
 * The composition root of the third deployment — and, imports and exports
 * alike, the same one `OrderApiModule` and `OrderWorkerModule` are. That is the
 * claim this package exists to make: `ApplicationModule` and `PersistenceModule`
 * are booted here unchanged, under a runtime that speaks a durable execution
 * engine instead of HTTP or a queue.
 *
 * Declared here rather than imported from a sibling for the reason
 * `order-worker` states: sharing the module would share that deployment's
 * transport dependency, and a Temporal worker that installs a web server to
 * reach its use cases would falsify the very thing this demonstrates. Three
 * processes, three composition roots, one application.
 */
export const OrderTemporalModule = Module("OrderTemporal")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [],
  exports: [PlaceOrder, FindOrder, Logger],
});
