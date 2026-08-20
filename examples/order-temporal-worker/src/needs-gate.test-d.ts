import { start } from "@btravstack/core";
/**
 * The compile-time half of the orchestration deployment: `start` resolves its
 * runtime from the `TemporalRuntime` port `TemporalModule` exports, and that
 * runtime needs nothing from the application context — its activities reach
 * it as a port the starter depends on through di. So there is no
 * `UNSATISFIED RUNTIME NEEDS` arm to pin here, as there was when the runtime
 * declared five `needs` of its own; what replaces it is di's gate.
 *
 * Two distinct negatives, at two distinct levels. `orderActivities`'s own
 * `deps` are the two pieces' PORTS (`fulfillOrder.port | chargeOrder.port`),
 * so a root that provides nothing at all for the starter's activities port
 * fails with THAT port unmet — `ActivitylessTemporal` below, coarse but
 * genuine. But `TemporalWorkflowActivities(contract, key)`'s own `deps` are
 * the REAL ports named in its `sync` call
 * (`packages/temporal/src/workflow-activities.ts`), not the piece's port —
 * that shielding is the composed provider's, one level up, and does NOT
 * apply inside a single slice. So a slice that forgets its own vertical
 * still surfaces its real ports as unmet needs the moment it is composed
 * into a root, exactly as the pre-slice, single-record `orderActivities`
 * used to: `FulfillmentlessSlice` below, reusing the real `fulfillOrder`
 * piece with `FulfillmentModule` left out of its imports, still leaks
 * `StockService | ShippingService` (and `Logger`, since neither
 * `FulfillmentlessSlice` nor `BillingSlice` here imports `observability()`)
 * out to `start`.
 *
 * Type-checked by this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { TemporalModule, TemporalRuntime, temporal } from "@btravstack/temporal";

import { OrderTemporalWorker, orderActivities } from "./module.js";
import { BillingSlice } from "./slices/billing/module.js";
import { fulfillOrder } from "./slices/fulfillment/activities.js";
import { FulfillmentSlice } from "./slices/fulfillment/module.js";

const options = { signals: false, probes: false } as const;

// Positive: the sugar exports the runtime port, and the activities provider's
// needs are met by the two slices, so the gate collapses to an empty tuple
// and this is an ordinary two-argument call.
const _wired = start(OrderTemporalWorker, options);

// The same graph without the starter: nothing declared over `RuntimePort` is
// exported, so there is nothing for `start` to boot. `observability()` is here
// so this arm fails on the RUNTIME alone — the two slices owe `Logger`
// otherwise, and a module failing two gates at once elaborates the other one.
const RuntimelessTemporal = Module("RuntimelessTemporal")({
  imports: [FulfillmentSlice, BillingSlice, observability()],
  provides: [orderActivities],
  exports: [orderActivities.port],
});

// Negative: the marker intersected onto `module` becomes a sentence naming the
// absence, which is what the call fails to match.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessTemporal, options);

// The starter without the activities it depends on at all: nothing provides
// the composed activities port, so it stays in the module's needs channel.
// Spelled with the `temporal()` primitive rather than `TemporalModule`, since
// the sugar cannot leave the activities out — that is what it is for.
const ActivitylessTemporal = Module("ActivitylessTemporal")({
  imports: [
    temporal({
      contract: orderContract,
      workflows: { workflowsPath: "./workflows.js" },
    }),
  ],
  exports: [TemporalRuntime],
});

// Negative, di's gate rather than the kernel's: `start` takes a
// `Module<X, E, Scope | Env>`, and this one still owes the activities port.
// @ts-expect-error — UNMET NEED: the module's needs channel carries the activities port, which nothing provides.
const _missingActivities = start(ActivitylessTemporal, options);

// The real `fulfillOrder` piece, composed into a slice that forgets
// `FulfillmentModule`: the piece's own `deps` (`PlaceOrder`,
// `OrderRepository`, `StockService`, `ShippingService`) are real ports, and
// only the first two are met here.
const FulfillmentlessSlice = Module("FulfillmentlessSlice")({
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [fulfillOrder],
  exports: [fulfillOrder],
});

const FulfillmentlessTemporal = TemporalModule("FulfillmentlessTemporal")({
  contract: orderContract,
  activities: orderActivities,
  workflows: { workflowsPath: "./workflows.js" },
  imports: [FulfillmentlessSlice, BillingSlice],
});

// Negative: `start` accepts a module whose outstanding needs are `Scope` and
// `Env` alone, and this one still owes `StockService | ShippingService` (and
// `Logger`, since neither slice here imports `observability()`) — the same
// shape of failure the pre-slice `orderActivities` used to surface directly,
// now surfacing through a slice instead.
// @ts-expect-error — UNMET NEED: `Logger | StockService | ShippingService` is not assignable to `Env | Scope`.
const _missingFulfillment = start(FulfillmentlessTemporal, options);
