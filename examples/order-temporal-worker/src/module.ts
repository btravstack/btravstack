import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { TemporalActivities, TemporalModule } from "@btravstack/temporal";
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
 * The composition root of the orchestration deployment — now a list of slices
 * plus what no slice owns: `TemporalModule`, the sugar that imports the
 * starter (`temporal()`, the runtime itself on `TemporalRuntime`, bound from
 * `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` in the environment, with the
 * connection as a resource of the graph), provides `orderActivities` and
 * exports the runtime — the plain di module a root would otherwise spell by
 * hand — and `observability()`, the `Logger` every slice's stand-ins write to
 * (`LOG_LEVEL`, JSON on stdout, every line carrying the activity attempt's own
 * trace id).
 *
 * The root no longer imports `OrderApplicationModule`, `OrderPersistenceModule`
 * or `FulfillmentModule` directly: `FulfillmentSlice` imports the orders
 * vertical plus the two fulfillment services, `BillingSlice` imports
 * `BillingModule` alone, and the two verticals meet only here — in the list of
 * slices, never inside one slice's own graph. `PlaceOrder` is as invisible to
 * billing as `PaymentService` is to fulfillment.
 *
 * `orderActivities`'s own `deps` are the two pieces' PORTS, not what they
 * close over, so `flatten` discovers `fulfillOrder` and `chargeOrder` only
 * because `FulfillmentSlice` and `BillingSlice` both `provides` and `exports`
 * them — imported here for that reason, even though nothing in this file
 * names either piece directly. Drop one import and the composed activities
 * still type-checks; what fails is `start`, with a `WiringDefect` naming the
 * unmet port, not a compile error.
 *
 * A constant: configuration is read inside the graph, and where the workflow
 * code lives is a static fact of this deployment. `workflowsPathFromURL`
 * points Temporal at the workflow module so it can bundle it for the sandbox;
 * a spec hands over a prebuilt bundle instead, which is why `WorkflowSource`
 * has two arms.
 */
export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
  contract: orderContract,
  activities: orderActivities,
  workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
  imports: [FulfillmentSlice, BillingSlice, observability()],
});
