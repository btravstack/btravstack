import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { observability } from "@btravstack/observability";
import { TemporalModule } from "@btravstack/temporal";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { orderActivities } from "./activities.js";
import { FulfillmentModule } from "./fulfillment.js";

/**
 * The composition root of the orchestration deployment. `ApplicationModule`
 * and `PersistenceModule` are booted here unchanged — the same pair every
 * other deployment composes — plus `observability()`, the `Logger` the use
 * case and the fulfillment stand-ins write to (`LOG_LEVEL`, JSON on stdout,
 * every line carrying the activity attempt's own trace id), and
 * `FulfillmentModule`, the two external
 * services only this deployment orchestrates; `orderActivities`, the saga's
 * activities as a service on the starter's own activities port; and `TemporalModule`, the
 * sugar that imports the starter (`temporal()`, the runtime itself on
 * `TemporalRuntime`, bound from `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`
 * in the environment, with the connection as a resource of the graph),
 * provides the activities and exports the runtime — the plain di module a
 * root would otherwise spell by hand.
 *
 * A constant: configuration is read inside the graph, and where the workflow
 * code lives is a static fact of this deployment. `workflowsPathFromURL`
 * points Temporal at the workflow module so it can bundle it for the sandbox;
 * a spec hands over a prebuilt bundle instead, which is why `WorkflowSource`
 * has two arms.
 *
 * The runtime needs nothing from the application context: its activities are
 * a port the starter depends on through di, and the provider declares the
 * four ports it closes over — so a root that forgets `FulfillmentModule`
 * fails at `TemporalModule(...)`, di's gate, not the kernel's. Declared here
 * rather than imported from a sibling because sharing a composition root
 * would share its transport dependency — one application, one root per
 * process.
 */
export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
  contract: orderContract,
  activities: orderActivities,
  workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule, observability()],
});
