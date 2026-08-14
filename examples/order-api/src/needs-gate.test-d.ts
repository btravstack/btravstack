/**
 * The compile-time half of the transport layer: `orderApiRuntime` declares
 * four ports in `needs` — three application ports and its own config — and
 * `start`'s phantom rest-tuple gate turns a module that does not export them
 * all into a call-site arity error. Type-checked by this package's
 * `test:types` script, never executed.
 *
 * It exercises `RuntimeHost`'s `Context<InstanceType<Needs>>` — a runtime
 * declares its needs as port *classes* while di parameterises `Context` by
 * port *instances* — and, now that a config is one of those needs, it is also
 * what makes a deployment that forgot to import `httpConfig` fail here rather
 * than at boot.
 */
import { Config } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { start } from "@btravstack/start-core";
import {
  ApplicationModule,
  FindOrder,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { orderApiRuntime } from "./api-runtime.js";
import { httpConfig } from "./config.js";
import { OrderApiModule } from "./module.js";

const options = {
  runtime: orderApiRuntime(),
  signals: false,
  probes: false,
} as const;

// Positive: the composition root exports all four ports the runtime needs, so
// the gate collapses to an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderApiModule, options);

// The same graph, one port short: `Logger` is provided (the interactors depend
// on it) but not exported, so it is not in the application context the runtime
// is handed. `httpConfig` *is* exported, so the gate can only be answering
// about the one genuinely missing port.
const PartialApi = Module("PartialApi")({
  imports: [ApplicationModule, PersistenceModule, httpConfig, Config.source(process.env)],
  exports: [PlaceOrder, FindOrder, httpConfig],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Logger.
const _missingLogger = start(PartialApi, options);
