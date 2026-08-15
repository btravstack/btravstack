import { start } from "@btravstack/core";
/**
 * The compile-time half of the transport layer: `start` resolves its runtime
 * from the `HttpRuntime` port the composition root exports, and that runtime
 * needs `@btravstack/http`'s `HttpHandler` port — the HTTP surface itself,
 * which the application provides. `start`'s phantom rest-tuple gate turns a
 * module that exports neither into a call-site arity error. Type-checked by
 * this package's `test:types` script, never executed.
 *
 * This is the only place in the repo where a runtime with a NON-EMPTY `needs`
 * meets a real module, so it is also what exercises `RuntimeHost`'s
 * `Context<InstanceType<Needs>>` — a runtime declares its needs as port
 * *classes* while di parameterises `Context` by port *instances*.
 */
import { Module } from "@btravstack/di";
import { ApplicationModule, Logger, PlaceOrder } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpHandler, HttpRuntime, httpModule } from "@btravstack/http";

import { ApiModule } from "./handler.js";
import { orderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime and the port it needs, so
// the gate collapses to an empty tuple and this is an ordinary two-argument call.
const _wired = start(orderApi({ port: 0 }), options);

// The same graph without `httpModule`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessApi = Module("RuntimelessApi")({
  imports: [ApplicationModule, PersistenceModule, ApiModule],
  exports: [HttpHandler, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the missing
// runtime, and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);

// The same graph, one port short: `ApiModule` is not imported, so the HTTP
// surface the runtime resolves is not in the application context.
const HandlerlessApi = Module("HandlerlessApi")({
  imports: [ApplicationModule, PersistenceModule, httpModule({ port: 0 })],
  exports: [HttpRuntime, PlaceOrder, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export HttpHandler.
const _missingHandler = start(HandlerlessApi, options);

// Positive: a `unit` module rides the same gate — `RequestModule` needs
// `Logger`, which the composition root exports, so the fork the kernel opens
// per request is proven satisfiable here, at the call site.
const _withUnit = start(orderApi({ port: 0 }), { ...options, unit: RequestModule });

// Negative, the OTHER direction: the unit module's own needs must be covered
// by the module's exports (or `Scope`, which the fork opens). This composition
// satisfies the runtime half — `httpModule` and `ApiModule` are imported — but
// does not export `Logger`, so only the unit half of the gate can be what
// rejects the call.
const UnloggedApi = Module("UnloggedApi")({
  imports: [ApplicationModule, PersistenceModule, ApiModule, httpModule({ port: 0 })],
  exports: [HttpRuntime, HttpHandler],
});

// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
