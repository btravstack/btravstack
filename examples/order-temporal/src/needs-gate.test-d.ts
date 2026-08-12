/**
 * The compile-time half of the third deployment: `temporalWorkerRuntime`
 * declares two ports in `needs`, and `start`'s phantom rest-tuple gate turns a
 * module that does not export both into a call-site arity error. Type-checked
 * by this package's `test:types` script, never executed.
 *
 * Together with `order-api`'s and `order-worker`'s, this is what makes the
 * claim testable rather than asserted: three runtimes with non-empty `needs`,
 * all proven against the same application graph at the `start(...)` call site.
 */
import { Module } from "@btravstack/di";
import { start } from "@btravstack/start";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";
import { orderContract } from "@btravstack/start-example-order-temporal-contract";
import type { NativeConnection } from "@temporalio/worker";

import { OrderTemporalModule } from "./module.js";
import { temporalWorkerRuntime } from "./temporal-runtime.js";

// Never dereferenced: this file is checked, not run. The runtime's `needs` are
// what the gate reads, and they do not depend on a live connection.
declare const connection: NativeConnection;

const options = {
  runtime: temporalWorkerRuntime({
    contract: orderContract,
    connection,
    workflows: { workflowsPath: "./workflows.js" },
  }),
  signals: false,
  probes: false,
} as const;

// Positive: the composition root exports both ports the runtime needs (and a
// third it does not), so the gate collapses to an empty tuple and this is an
// ordinary two-argument call.
const _wired = start(OrderTemporalModule, options);

// The same graph, one port short: `Logger` is provided (the interactors depend
// on it) but not exported, so it is not in the application context the runtime
// is handed.
const PartialTemporal = Module("PartialTemporal")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [],
  exports: [PlaceOrder, FindOrder],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Logger.
const _missingLogger = start(PartialTemporal, options);
