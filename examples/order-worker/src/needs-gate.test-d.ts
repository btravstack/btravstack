/**
 * The compile-time half of the second deployment: `queueWorkerRuntime` declares
 * two ports in `needs`, and `start`'s phantom rest-tuple gate turns a module
 * that does not export both into a call-site arity error. Type-checked by this
 * package's `test:types` script, never executed.
 *
 * Together with `order-api`'s, this is what makes the claim testable rather
 * than asserted: two runtimes with different, non-empty `needs`, both proven
 * against the same application graph at the `start(...)` call site.
 */
import { Module } from "@btravstack/di";
import { start } from "@btravstack/start-core";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { OrderWorkerModule } from "./module.js";
import { queueWorkerRuntime } from "./queue-runtime.js";
import { createOrderQueue } from "./queue.js";

const options = {
  runtime: queueWorkerRuntime({ queue: createOrderQueue() }),
  signals: false,
  probes: false,
} as const;

// Positive: the composition root exports both ports the runtime needs (and a
// third it does not), so the gate collapses to an empty tuple and this is an
// ordinary two-argument call.
const _wired = start(OrderWorkerModule, options);

// The same graph, one port short: `Logger` is provided (the interactors depend
// on it) but not exported, so it is not in the application context the runtime
// is handed.
const PartialWorker = Module("PartialWorker")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [],
  exports: [PlaceOrder, FindOrder],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Logger.
const _missingLogger = start(PartialWorker, options);
