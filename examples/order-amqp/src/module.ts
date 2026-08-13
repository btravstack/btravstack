import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

/**
 * The composition root of the fourth deployment — and, imports and exports
 * alike, the same one `OrderApiModule`, `OrderWorkerModule` and
 * `OrderTemporalModule` are. `ApplicationModule` and `PersistenceModule` are
 * booted here unchanged, under a runtime that speaks AMQP instead of HTTP, an
 * in-memory queue or a durable execution engine.
 *
 * Declared here rather than imported from a sibling for the reason
 * `order-worker` states: sharing the module would share that deployment's
 * transport dependency, and a broker consumer that installs a web server to
 * reach its use cases would falsify the very thing this demonstrates. Four
 * processes, four composition roots, one application.
 */
export const OrderAmqpModule = Module("OrderAmqp")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [],
  exports: [PlaceOrder, FindOrder, Logger],
});
