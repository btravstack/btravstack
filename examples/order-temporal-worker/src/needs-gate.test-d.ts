import { Env } from "@btravstack/config";
import { start, Logger } from "@btravstack/core";
/**
 * The compile-time half of the orchestration deployment: `start` resolves its
 * runtime from the `TemporalRuntime` port `TemporalModule` exports, and that
 * runtime resolves nothing from the application context — its activities reach
 * it as a port the starter depends on through di. So there is no
 * `UNSATISFIED RUNTIME PORTS` arm to pin here, as there was when the runtime
 * resolved five ports of its own; what replaces it is di's needs channel —
 * refused by `start`'s `Module<X, E, Scope | Env>` parameter, which names the
 * port, and NOT di's `UNSATISFIED DEPENDENCIES` dependency gate.
 *
 * Two distinct negatives, at two distinct levels. `orderActivities`'s own
 * `deps` are the two pieces' PORTS (`fulfillOrder.port | chargeOrder.port`),
 * so a root that provides nothing at all for the starter's activities port
 * fails with THAT port unmet — `ActivitylessTemporal` below, coarse but
 * genuine. But `TemporalWorkflowActivities(contract, key)`'s own `deps` are
 * the REAL ports named in its `sync` call
 * (`packages/temporal-worker/src/workflow-activities.ts`), not the piece's port —
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
import { Module, Port, Provider } from "@btravstack/di";
import {
  OrderApplicationModule,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { Storage } from "@btravstack/storage";
import {
  TemporalActivities,
  TemporalModule,
  TemporalRuntime,
  temporal,
} from "@btravstack/temporal-worker";
import { OkAsync } from "unthrown";

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
  needs: [Env],
  imports: [FulfillmentSlice, BillingSlice, observability()],
  provides: [orderActivities],
  exports: [orderActivities.port],
});

// Negative: the marker intersected onto `module` becomes a sentence naming the
// absence, which is what the call fails to match.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessTemporal, options);

// The starter without the activities it depends on at all. Spelled with the
// `temporal()` primitive rather than `TemporalModule`, since the sugar cannot
// leave the activities out — that is what it is for.
//
// The KERNEL's gate rather than di's declaration one: the port is owed by
// `temporal()`, an IMPORT, and an import's needs travel published in its type
// rather than being re-declared here.
const ActivitylessTemporal = Module("ActivitylessTemporal")({
  imports: [
    temporal({
      contract: orderContract,
      workflows: { workflowsPath: "./workflows.js" },
    }),
  ],
  exports: [TemporalRuntime],
});

// @ts-expect-error — UNMET NEED: the module's needs channel carries the activities port.
const _missingActivities = start(ActivitylessTemporal, options);

// The real `fulfillOrder` piece, composed into a slice that forgets
// `FulfillmentModule`: the piece's own `deps` (`PlaceOrder`,
// `OrderRepository`, `StockService`, `ShippingService`) are real ports, and
// only the first two are met here.
// The slice's OWN provider is what reads them, so this one IS di's declaration
// gate — the distinction the two negatives above draw.
// @ts-expect-error — UNDECLARED NEEDS: StockService | ShippingService (which
// `FulfillmentModule` would have provided) and Storage (which the root
// composes), all three read by the slice's own activities provider.
const FulfillmentlessSlice = Module("FulfillmentlessSlice")({
  needs: [Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [fulfillOrder],
  exports: [fulfillOrder],
});

void FulfillmentlessSlice;

// The same slice with every port it owes declared. Legal at the module now —
// which is the whole distinction the two gates draw: declaring moves the
// obligation to whoever composes it, it does not discharge it.
const DeclaredFulfillmentless = Module("DeclaredFulfillmentless")({
  needs: [Env, Logger, StockService, ShippingService, Storage],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [fulfillOrder],
  exports: [fulfillOrder],
});

const FulfillmentlessTemporal = TemporalModule("FulfillmentlessTemporal")({
  needs: [Env, Logger, StockService, ShippingService, Storage],
  contract: orderContract,
  activities: orderActivities,
  workflows: { workflowsPath: "./workflows.js" },
  imports: [DeclaredFulfillmentless, BillingSlice],
});

// Negative: `start` accepts a module whose outstanding needs are `Scope` and
// `Env` alone, and this one still owes `StockService | ShippingService` (and
// `Logger`, since neither slice here imports `observability()`) — the same
// shape of failure the pre-slice `orderActivities` used to surface directly,
// now surfacing through a slice instead.
// @ts-expect-error — UNMET NEED: `Logger | StockService | ShippingService` is not assignable to `Env | Scope`.
const _missingFulfillment = start(FulfillmentlessTemporal, options);

// The `unit` needs-propagation gate: a bound `unit.activity` module's own
// unmet needs join `TemporalModule`'s own Needs channel (an import's own
// unmet needs are not `TemporalModule`'s OWN call to re-declare — di's
// `NeedsGate` TSDoc), so the gate that refuses them is `start`'s ordinary
// `UNSATISFIED DEPENDENCIES`, never a marker of the kernel's.
//
// A trivial activities provider, deliberately with no injected services of
// its own: the only need either call below can leak is the unit module's.
const unitGateActivities = TemporalActivities(orderContract)({
  inject: {},
  sync: () => ({
    fulfillOrder: {
      place: () => OkAsync(null as never),
      reserveStock: () => OkAsync(undefined),
      arrangeShipping: () => OkAsync(undefined),
      releaseStock: () => OkAsync(undefined),
      cancelPlacement: () => OkAsync(undefined),
    },
    chargeOrder: {
      authorizePayment: () => OkAsync(null as never),
      capturePayment: () => OkAsync(undefined),
      refundPayment: () => OkAsync(undefined),
    },
  }),
});

class TemporalUnitDep extends Port("TemporalUnitDep")<{ readonly value: number }> {}
class TemporalUnitMark extends Port("TemporalUnitMark")<{ readonly at: number }> {}
const TemporalUnitModule = Module("TemporalUnitModule")({
  needs: [TemporalUnitDep],
  provides: [
    Provider(TemporalUnitMark)({
      inject: { dep: TemporalUnitDep },
      sync: ({ dep }) => ({ at: dep.value }),
    }),
  ],
  exports: [TemporalUnitMark],
});

const _withUnitSatisfied = start(
  TemporalModule("WithUnitSatisfied")({
    contract: orderContract,
    activities: unitGateActivities,
    workflows: { workflowsPath: "./workflows.js" },
    unit: { activity: TemporalUnitModule },
    provides: [Provider(TemporalUnitDep)({ inject: {}, value: { value: 1 } })],
  }),
  options,
);
void _withUnitSatisfied;

const _unloggedUnit = TemporalModule("WithUnitUnmet")({
  contract: orderContract,
  activities: unitGateActivities,
  workflows: { workflowsPath: "./workflows.js" },
  unit: { activity: TemporalUnitModule },
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `TemporalUnitDep`, which `TemporalUnitModule` needs
const _withUnitUnmet = start(_unloggedUnit, options);
void _withUnitUnmet;
