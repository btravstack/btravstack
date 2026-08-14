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
