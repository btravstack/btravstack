import { start } from "@btravstack/core";
/**
 * The compile-time half of the orchestration deployment: `start` resolves its
 * runtime from the `TemporalRuntime` port `TemporalModule` exports, and that
 * runtime needs nothing from the application context — its activities reach
 * it as a port the starter depends on through di. So there is no
 * `UNSATISFIED RUNTIME NEEDS` arm to pin here, as there was when the runtime
 * declared five `needs` of its own; what replaces it is di's gate: a root
 * whose activities provider closes over `StockService` and `ShippingService`
 * without importing `FulfillmentModule` carries them as unmet needs, and
 * `start` — which accepts only `Scope` and `Env` outstanding — rejects the
 * module at the call site.
 * Type-checked by this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalModule } from "@btravstack/temporal";

import { OrderActivities, orderActivities } from "./activities.js";
import { FulfillmentModule } from "./fulfillment.js";
import { OrderTemporalWorker } from "./module.js";

const options = { signals: false, probes: false } as const;

// Positive: the sugar exports the runtime port, and the activities provider's
// four needs are met by the three imports, so the gate collapses to an empty
// tuple and this is an ordinary two-argument call.
const _wired = start(OrderTemporalWorker, options);

// The same graph without the starter: nothing declared over `RuntimePort` is
// exported, so there is nothing for `start` to boot.
const RuntimelessTemporal = Module("RuntimelessTemporal")({
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule],
  provides: [orderActivities],
  exports: [OrderActivities],
});

// Negative: the gate becomes a required two-element tuple naming the absence,
// and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessTemporal, options);

// The same sugar without `FulfillmentModule`: `orderActivities` depends on
// `StockService` and `ShippingService`, and nothing provides them, so the
// module carries them as needs — di lets the composition stand and reports the
// hole where the module is booted.
const FulfillmentlessTemporal = TemporalModule("FulfillmentlessTemporal")({
  contract: orderContract,
  activities: orderActivities,
  workflows: { workflowsPath: "./workflows.js" },
  imports: [ApplicationModule, PersistenceModule],
});

// Negative: `start` accepts a module whose outstanding needs are `Scope` and
// `Env` alone, and this one still owes the two fulfillment services.
// @ts-expect-error — UNMET NEED: `StockService | ShippingService` is not assignable to `Env | Scope`.
const _missingFulfillment = start(FulfillmentlessTemporal, options);
