import { start } from "@btravstack/core";
/**
 * The compile-time half of the transport layer: `httpRuntime` declares three
 * ports in `needs`, and `start`'s phantom rest-tuple gate turns a module that
 * does not export all three into a call-site arity error. Type-checked by this
 * package's `test:types` script, never executed.
 *
 * This is the only place in the repo where a runtime with a NON-EMPTY `needs`
 * meets a real module, so it is also what exercises `RuntimeHost`'s
 * `Context<InstanceType<Needs>>` — a runtime declares its needs as port
 * *classes* while di parameterises `Context` by port *instances*.
 */
import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { httpRuntime } from "@btravstack/http";

import { apiHandler } from "./handler.js";
import { OrderApiModule } from "./module.js";
import { RequestModule } from "./request-scope.js";

const options = {
  runtime: httpRuntime({ port: 0, needs: [PlaceOrder, FindOrder, Logger], handler: apiHandler }),
  signals: false,
  probes: false,
} as const;

// Positive: the composition root exports all three ports the runtime needs, so
// the gate collapses to an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderApiModule, options);

// The same graph, one port short: `Logger` is provided (the interactors depend
// on it) but not exported, so it is not in the application context the runtime
// is handed.
const PartialApi = Module("PartialApi")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, FindOrder],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Logger.
const _missingLogger = start(PartialApi, options);

// Positive: a `unit` module rides the same gate — `RequestModule` needs
// `Logger`, which the composition root exports, so the fork the kernel opens
// per request is proven satisfiable here, at the call site.
const _withUnit = start(OrderApiModule, { ...options, unit: RequestModule });

// Negative, the OTHER direction: the unit module's own needs must be covered
// by the module's exports (or `Scope`, which the fork opens). `PartialApi`
// does not export `Logger`, so this fails both halves of the gate — the
// runtime half is checked first and names the error, but the call is rejected
// either way, which is what this pin holds.
// @ts-expect-error — the module does not export Logger, for the runtime or for RequestModule.
const _unitOverPartial = start(PartialApi, { ...options, unit: RequestModule });
