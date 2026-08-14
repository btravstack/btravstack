import { Config } from "@btravstack/config";
import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { httpConfig, probeConfig } from "./config.js";

/**
 * The composition root, and the only file in the example that knows both halves
 * exist. `ApplicationModule` leaves `OrderRepository` unmet; `PersistenceModule`
 * provides it. Importing both is what closes di's arity gate — and the ports
 * re-exported here are exactly what `orderApiRuntime` declares as its needs,
 * which closes the kernel's.
 *
 * Configuration is imported the same way, because that is all a config is: a
 * module providing a port. `Config.source(process.env)` is the one place the
 * environment enters the graph, so `Config.parse`'s pre-boot check and the
 * providers that inject the values cannot disagree about what it held.
 *
 * `probeConfig` is imported but not exported: nothing in the graph resolves
 * it, and it is here so `PROBE_PORT` is validated by the same pre-boot pass as
 * every other variable.
 *
 * `PersistenceModule`'s database provider is resourceful, so this module carries
 * a `Scope` need that only `Module.scoped` discharges — which is what `start`
 * does, once, for the whole process.
 */
export const OrderApiModule = Module("OrderApi")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    httpConfig,
    probeConfig,
    Config.source(process.env),
  ],
  exports: [PlaceOrder, FindOrder, Logger, httpConfig],
});
