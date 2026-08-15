import { start } from "@btravstack/core";
/**
 * The compile-time half of the orchestration deployment: the runtime is a
 * service the module provides on `OrderTemporalRuntime`, it declares five
 * ports in `needs`, and `start`'s phantom rest-tuple gate turns a module that
 * exports no runtime — or one that does not export every port the runtime
 * needs — into a call-site arity error. Type-checked by this package's
 * `test:types` script, never executed.
 *
 * Together with `order-api`'s and `order-amqp-worker`'s, this is what makes the
 * claim testable rather than asserted: three runtimes with non-empty `needs`,
 * all proven against the same application graph at the `start(...)` call site.
 */
import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";

import { FulfillmentModule } from "./fulfillment.js";
import { OrderTemporalWorker } from "./module.js";
import { OrderTemporalRuntime, temporalModule } from "./temporal-runtime.js";

const transport = {
  contract: orderContract,
  workflows: { workflowsPath: "./workflows.js" },
} as const;

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime port and every port the
// runtime needs, so the gate collapses to an empty tuple and this is an
// ordinary two-argument call.
const _wired = start(OrderTemporalWorker, options);

// The same graph without the runtime: nothing declared over `RuntimePort` is
// exported, so there is nothing for `start` to boot.
const RuntimelessTemporal = Module("RuntimelessTemporal")({
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule],
  exports: [PlaceOrder, OrderRepository, StockService, ShippingService, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the absence,
// and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessTemporal, options);

// The same graph, one port short: `Logger` is provided (the interactors depend
// on it) but not exported, so it is not in the application context the runtime
// is handed.
const PartialTemporal = Module("PartialTemporal")({
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule, temporalModule(transport)],
  exports: [
    OrderTemporalRuntime,
    PlaceOrder,
    FindOrder,
    OrderRepository,
    StockService,
    ShippingService,
  ],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Logger.
const _missingLogger = start(PartialTemporal, options);
