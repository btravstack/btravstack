import { start } from "@btravstack/core";
/**
 * The compile-time half of the orchestration deployment: `start` resolves its
 * runtime from the `TemporalRuntime` port the composition root exports, and
 * that runtime needs nothing from the application context — its activities
 * reach it as a port `temporal()` depends on through di. So there is no
 * `UNSATISFIED RUNTIME NEEDS` arm to pin here, as there was when the runtime
 * declared five `needs` of its own; what replaces it is di's gate: a root that
 * imports `temporal({ activities: OrderActivities })` without providing
 * `OrderActivities` carries it as an unmet need, and `start` — which accepts
 * only `Scope` and `Env` outstanding — rejects the module at the call site.
 * Type-checked by this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalRuntime, temporal } from "@btravstack/temporal";

import { ActivitiesModule, OrderActivities } from "./activities.js";
import { FulfillmentModule } from "./fulfillment.js";
import { OrderTemporalWorker } from "./module.js";

const transport = {
  contract: orderContract,
  activities: OrderActivities,
  workflows: { workflowsPath: "./workflows.js" },
} as const;

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime port, and the starter's
// one need is met by `ActivitiesModule`, so the gate collapses to an empty
// tuple and this is an ordinary two-argument call.
const _wired = start(OrderTemporalWorker, options);

// The same graph without the starter: nothing declared over `RuntimePort` is
// exported, so there is nothing for `start` to boot.
const RuntimelessTemporal = Module("RuntimelessTemporal")({
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule, ActivitiesModule],
  exports: [OrderActivities],
});

// Negative: the gate becomes a required two-element tuple naming the absence,
// and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessTemporal, options);

// The same graph without `ActivitiesModule`: `temporal()` depends on
// `OrderActivities`, and nothing provides it, so the module carries it as a
// need — di lets the composition stand and reports the hole where the module
// is booted.
const ActivitylessTemporal = Module("ActivitylessTemporal")({
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule, temporal(transport)],
  exports: [TemporalRuntime],
});

// Negative: `start` accepts a module whose outstanding needs are `Scope` and
// `Env` alone, and this one still owes `OrderActivities`.
// @ts-expect-error — UNMET NEED: `OrderActivities` is not assignable to `Env | Scope`.
const _missingActivities = start(ActivitylessTemporal, options);
