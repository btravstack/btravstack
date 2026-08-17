import { start } from "@btravstack/core";
/**
 * The compile-time half of the orchestration deployment: `start` resolves its
 * runtime from the `TemporalRuntime` port `TemporalModule` exports, and that
 * runtime needs nothing from the application context — its activities reach
 * it as a port the starter depends on through di. So there is no
 * `UNSATISFIED RUNTIME NEEDS` arm to pin here, as there was when the runtime
 * declared five `needs` of its own; what replaces it is di's gate: a root
 * whose activities provider closes over the starter's activities port without
 * providing it is rejected by `start` — which accepts only `Scope` and `Env`
 * outstanding — at the call site.
 *
 * `orderActivities`'s own needs are the two pieces' PORTS
 * (`fulfillOrder.port | chargeOrder.port`), not what the pieces close over —
 * dropping `FulfillmentSlice` or `BillingSlice` leaves a piece's port unmet,
 * which is di's `WiringDefect` at `start`, not a compile error (see
 * `module.ts`'s own TSDoc). So the negative pinned here is coarser, and
 * spelled with the `temporal()` primitive rather than `TemporalModule`, since
 * the sugar cannot leave the activities out at all — that is what it is for.
 * Type-checked by this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalRuntime, temporal } from "@btravstack/temporal";

import { OrderTemporalWorker, orderActivities } from "./module.js";
import { BillingSlice } from "./slices/billing/module.js";
import { FulfillmentSlice } from "./slices/fulfillment/module.js";

const options = { signals: false, probes: false } as const;

// Positive: the sugar exports the runtime port, and the activities provider's
// needs are met by the two slices, so the gate collapses to an empty tuple
// and this is an ordinary two-argument call.
const _wired = start(OrderTemporalWorker, options);

// The same graph without the starter: nothing declared over `RuntimePort` is
// exported, so there is nothing for `start` to boot.
const RuntimelessTemporal = Module("RuntimelessTemporal")({
  imports: [FulfillmentSlice, BillingSlice],
  provides: [orderActivities],
  exports: [orderActivities.port],
});

// Negative: the gate becomes a required two-element tuple naming the absence,
// and the call fails on arity.
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
