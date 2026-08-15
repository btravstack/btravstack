import { Module } from "@btravstack/di";
import { ApplicationModule, Logger } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpHandler, HttpRuntime, http } from "@btravstack/http";

import { ApiModule } from "./api.js";

/**
 * The composition root, and the only file in the example that knows the three
 * halves exist. `ApplicationModule` leaves `OrderRepository` unmet;
 * `PersistenceModule` provides it; `ApiModule` provides the HTTP surface as
 * `@btravstack/http`'s `HttpHandler` port; and `http()` provides the runtime
 * itself, on `HttpRuntime`, bound from `PORT` and `HOST` in the environment.
 * Importing them is what closes di's arity gate — and the exports here are
 * exactly what `start` resolves (`HttpRuntime`), what that runtime needs
 * (`HttpHandler`) and what the per-request `RequestModule` reads (`Logger`),
 * which closes the kernel's.
 *
 * A constant, not a function: configuration is read inside the graph, from the
 * `Env` port the kernel provides, so nothing has to be passed in from
 * `main.ts` — and a spec boots this very module with `env: { PORT: "0" }`.
 *
 * `PersistenceModule`'s database provider is resourceful, so this module carries
 * a `Scope` need that only `Module.scoped` discharges — which is what `start`
 * does, once, for the whole process.
 */
export const OrderApi = Module("OrderApi")({
  imports: [ApplicationModule, PersistenceModule, ApiModule, http()],
  exports: [HttpRuntime, HttpHandler, Logger],
});
