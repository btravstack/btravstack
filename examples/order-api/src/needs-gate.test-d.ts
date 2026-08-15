import { start } from "@btravstack/core";
/**
 * The compile-time half of the transport layer: `httpRuntime` needs
 * `@btravstack/http`'s `HttpHandler` port — the HTTP surface itself, which the
 * application provides — and `start`'s phantom rest-tuple gate turns a module
 * that does not export it into a call-site arity error. Type-checked by this
 * package's `test:types` script, never executed.
 *
 * This is the only place in the repo where a runtime with a NON-EMPTY `needs`
 * meets a real module, so it is also what exercises `RuntimeHost`'s
 * `Context<InstanceType<Needs>>` — a runtime declares its needs as port
 * *classes* while di parameterises `Context` by port *instances*.
 */
import { Module } from "@btravstack/di";
import { ApplicationModule, Logger, PlaceOrder } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpHandler, httpRuntime } from "@btravstack/http";

import { ApiModule } from "./handler.js";
import { OrderApiModule } from "./module.js";
import { RequestModule } from "./request-scope.js";

const options = { runtime: httpRuntime({ port: 0 }), signals: false, probes: false } as const;

// Positive: the composition root exports the port the runtime needs, so the
// gate collapses to an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderApiModule, options);

// The same graph, one port short: `ApiModule` is not imported, so the HTTP
// surface the runtime resolves is not in the application context.
const HandlerlessApi = Module("HandlerlessApi")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export HttpHandler.
const _missingHandler = start(HandlerlessApi, options);

// Positive: a `unit` module rides the same gate — `RequestModule` needs
// `Logger`, which the composition root exports, so the fork the kernel opens
// per request is proven satisfiable here, at the call site.
const _withUnit = start(OrderApiModule, { ...options, unit: RequestModule });

// Negative, the OTHER direction: the unit module's own needs must be covered
// by the module's exports (or `Scope`, which the fork opens). This composition
// satisfies every runtime need — `ApiModule` is imported — but does not export
// `Logger`, so only the unit half of the gate can be what rejects the call.
const UnloggedApi = Module("UnloggedApi")({
  imports: [ApplicationModule, PersistenceModule, ApiModule],
  exports: [HttpHandler],
});

// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
