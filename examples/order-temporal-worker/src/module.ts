import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { TemporalActivities, TemporalModule } from "@btravstack/temporal";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { pieces, slices } from "./slices.gen.js";

/**
 * The activities record, composed from each slice's own piece — keyed by the
 * contract's own workflow names, so a workflow with no piece is a compile
 * error and two pieces claiming one key are di's duplicate-provider defect at
 * build.
 */
export const orderActivities = TemporalActivities(orderContract)(pieces);

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
 * or `FulfillmentModule` directly: the fulfillment slice imports the orders
 * vertical plus the two fulfillment services, the billing slice imports
 * `BillingModule` alone, and the two verticals meet only here — in the list of
 * slices, never inside one slice's own graph. `PlaceOrder` is as invisible to
 * billing as `PaymentService` is to fulfillment.
 *
 * `orderActivities`'s own `deps` are the two pieces' PORTS, not what they
 * close over. Naming a piece in that composing array is not what registers
 * it: `flatten` walks `imports` and `provides` only, never a provider's own
 * `deps` — so the two pieces are discharged by their own slices, which
 * `provides` and `exports` them. `...slices` spreads every slice
 * `slices.gen.ts` found — generated from the same `src/slices/*` directories
 * `orderActivities`'s `pieces` came from — into `imports`, so a slice on disk
 * is a slice in `imports` by construction: there is no longer a hole where
 * dropping one leaves its piece's port unmet and `start` fails at runtime
 * with a `WiringDefect`.
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
  imports: [...slices, observability()],
});
