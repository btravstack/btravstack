import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";

import { orderRouter } from "./router.js";

/**
 * The composition root, and the only file in the example that knows the three
 * halves exist. `ApplicationModule` leaves `OrderRepository` unmet;
 * `PersistenceModule` provides it; `orderRouter` provides the oRPC router as a
 * service that declares the two use cases its procedures call;
 * `observability()` provides the `Logger` the interactors and the request
 * scope write to, bound from `LOG_LEVEL` and writing one JSON object per line
 * on stdout; and `http()` is the whole transport — the runtime on
 * `HttpRuntime`, bound from
 * `PORT` and `HOST` in the environment, and the router mounted under `/rpc`,
 * needing the router the root provides. Importing them is what closes di's
 * arity gate (a composition without the router provider does not compile —
 * the starter's provider depends on it), and the exports here are exactly
 * what `start` resolves (`HttpRuntime`) and what the per-request
 * `RequestModule` reads (`Logger`), which closes the kernel's.
 *
 * A constant, not a function: configuration is read inside the graph, from the
 * `Env` port the kernel provides, so nothing has to be passed in from
 * `main.ts` — and a spec boots this very module with `env: { PORT: "0" }`.
 *
 * `PersistenceModule`'s database provider is resourceful, so this module carries
 * a `Scope` need that only `Module.scoped` discharges — which is what `start`
 * does, once, for the whole process.
 */
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [ApplicationModule, PersistenceModule, observability()],
  exports: [Logger],
});
