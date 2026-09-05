import { Tracer } from "@btravstack/core";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { UnitSpanModule, otel } from "@btravstack/observability/otel";
import { storage } from "@btravstack/storage";
import { s3Storage } from "@btravstack/storage/s3";
import { TemporalActivities, TemporalModule } from "@btravstack/temporal-worker";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { chargeOrder } from "./slices/billing/activities.js";
import { BillingSlice } from "./slices/billing/module.js";
import { fulfillOrder } from "./slices/fulfillment/activities.js";
import { FulfillmentSlice } from "./slices/fulfillment/module.js";

/**
 * The activities record, composed from each slice's own piece — keyed by the
 * contract's own workflow names, so a workflow with no piece is a compile
 * error and two pieces claiming one key are di's duplicate-provider defect at
 * build.
 */
export const orderActivities = TemporalActivities(orderContract)([fulfillOrder, chargeOrder]);

/**
 * The composition root of the orchestration deployment: a list of slices plus
 * what no slice owns. `FulfillmentSlice` imports the orders vertical plus the
 * two fulfillment services, `BillingSlice` imports `BillingModule` alone, and
 * the two verticals meet only here — `PlaceOrder` is as invisible to billing as
 * `PaymentService` is to fulfillment.
 *
 * Both slices are imported even though the composing call above already names
 * their pieces: `orderActivities`'s `deps` are the pieces' PORTS, and `flatten`
 * walks `imports` and `provides` only, never a provider's own `deps`. Drop one
 * import and `orderActivities` still type-checks — but `TemporalActivities`
 * carries those ports as its OWN `deps`, so the root below sees an undeclared
 * need and fails to compile, naming the exact port, not a runtime surprise.
 *
 * `workflowsPath` names `./workflows.ts`, not `.js`: it is a **filesystem** path
 * Temporal's bundler stats, not an import specifier the `.js` convention applies
 * to, and these examples are source-only. A deployment that compiles to `dist/`
 * names the compiled file.
 */
export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
  contract: orderContract,
  activities: orderActivities,
  workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.ts") },
  imports: [
    FulfillmentSlice,
    BillingSlice,
    storage({ adapter: s3Storage() }),
    observability(),
    otel(),
  ],
  // Forked once dispatch accepts the attempt and before the activity body
  // runs, which is what lets the span wrap the whole attempt.
  unit: { activity: UnitSpanModule },
  // Exported because `UnitSpanModule` reads `Tracer` out of the application
  // scope once forked; `otel()` above is what provides it.
  exports: [Tracer],
});
