import { Module } from "@btravstack/di";
import { ApplicationModule, Logger } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpHandler } from "@btravstack/http";

import { ApiModule } from "./handler.js";

/**
 * The composition root, and the only file in the example that knows the three
 * halves exist. `ApplicationModule` leaves `OrderRepository` unmet;
 * `PersistenceModule` provides it; `ApiModule` provides the HTTP surface as
 * `@btravstack/http`'s `HttpHandler` port, from providers that declare the use
 * cases they call, so even the transport wiring lives in the graph. Importing
 * them is what closes di's arity gate — and the exports here are exactly what
 * `httpRuntime` needs (`HttpHandler`) plus what the per-request
 * `RequestModule` reads (`Logger`), which closes the kernel's.
 *
 * `PersistenceModule`'s database provider is resourceful, so this module carries
 * a `Scope` need that only `Module.scoped` discharges — which is what `start`
 * does, once, for the whole process.
 */
export const OrderApiModule = Module("OrderApi")({
  imports: [ApplicationModule, PersistenceModule, ApiModule],
  exports: [HttpHandler, Logger],
});
