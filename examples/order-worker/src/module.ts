import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

/**
 * The composition root of the second deployment — and, imports and exports
 * alike, the same one `OrderApiModule` is. That is the claim this package
 * exists to make: `ApplicationModule` and `PersistenceModule` are booted here
 * unchanged, under a runtime that speaks a queue instead of HTTP.
 *
 * It is declared here rather than imported from `order-api` on purpose. Sharing
 * the module would also share the API's oRPC dependency, and a worker
 * deployment that installs a web server to reach its use cases would falsify
 * the very thing this is demonstrating. Two processes, two composition roots,
 * one application.
 */
export const OrderWorkerModule = Module("OrderWorker")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, FindOrder, Logger],
});
