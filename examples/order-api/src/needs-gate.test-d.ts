import { start } from "@btravstack/core";
/**
 * The compile-time half of the transport layer: `start` resolves its runtime
 * from the `HttpRuntime` port the composition root exports, and
 * `http()`'s runtime provider depends on the router port through
 * di. Two gates, both at compile time: `start`'s phantom rest-tuple gate turns
 * a module that exports no runtime into a call-site arity error, and di's own
 * `Module` typing turns a composition that imports the starter without
 * providing its router into an unmet need `start` refuses. Type-checked by
 * this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import { ApplicationModule, Logger } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpRuntime, http } from "@btravstack/http";

import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";
import { orderRouter } from "./router.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime, so the gate collapses to
// an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderApi, options);

// The same graph without `http(...)`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessApi = Module("RuntimelessApi")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [orderRouter],
  exports: [Logger],
});

// Negative: the gate becomes a required two-element tuple naming the missing
// runtime, and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);

// The starter imported without its router provided: `http()`'s runtime
// provider depends on the starter's own router port (the one
// `HttpRouter(contract)(deps, arm)` provides), so the composition carries it
// as an unmet need — di's gate, not the kernel's, and it rejects the module
// at `start` rather than at arity.
const RouterlessApi = Module("RouterlessApi")({
  imports: [ApplicationModule, PersistenceModule, http()],
  exports: [HttpRuntime, Logger],
});

// @ts-expect-error — the composition needs the router port and nothing provides it.
const _missingRouter = start(RouterlessApi, options);

// Positive: a `unit` module rides the same gate — `RequestModule` needs
// `Logger`, which the composition root exports, so the fork the kernel opens
// per request is proven satisfiable here, at the call site.
const _withUnit = start(OrderApi, { ...options, unit: RequestModule });

// Negative, the OTHER direction: the unit module's own needs must be covered
// by the module's exports (or `Scope`, which the fork opens). This composition
// has its runtime and router but does not export `Logger`, so only the unit
// half of the gate can be what rejects the call.
const UnloggedApi = Module("UnloggedApi")({
  imports: [ApplicationModule, PersistenceModule, http()],
  provides: [orderRouter],
  exports: [HttpRuntime],
});

// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
