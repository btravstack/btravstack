import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

/**
 * The composition root, and the only file in the example that knows both halves
 * exist. `ApplicationModule` leaves `OrderRepository` unmet; `PersistenceModule`
 * provides it. Importing both is what closes di's arity gate — and the three
 * ports re-exported here are exactly what `main.ts` declares as `httpRuntime`'s
 * needs, which closes the kernel's.
 *
 * `PersistenceModule`'s database provider is resourceful, so this module carries
 * a `Scope` need that only `Module.scoped` discharges — which is what `start`
 * does, once, for the whole process.
 */
export const OrderApiModule = Module("OrderApi")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, FindOrder, Logger],
});
