import { Module } from "@btravstack/di";
import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalRuntime, temporal } from "@btravstack/temporal";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { ActivitiesModule, OrderActivities } from "./activities.js";
import { FulfillmentModule } from "./fulfillment.js";

/**
 * The composition root of the orchestration deployment. `ApplicationModule`
 * and `PersistenceModule` are booted here unchanged — the same pair every
 * other deployment composes — plus `FulfillmentModule`, the two external
 * services only this deployment orchestrates; `ActivitiesModule`, the saga's
 * activities as a service on `OrderActivities`; and `temporal()`, the starter
 * that provides the runtime itself on `TemporalRuntime`, bound from
 * `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` in the environment, with the
 * connection as a resource of the graph.
 *
 * A constant: configuration is read inside the graph, and where the workflow
 * code lives is a static fact of this deployment. `workflowsPathFromURL`
 * points Temporal at the workflow module so it can bundle it for the sandbox;
 * a spec hands over a prebuilt bundle instead, which is why `WorkflowSource`
 * has two arms.
 *
 * The one export is what `start` resolves. The runtime needs nothing from the
 * application context: its activities are a port `temporal()` depends on
 * through di, so a root that forgets `ActivitiesModule` fails at `Module(...)`
 * — di's gate, not the kernel's. Declared here rather than imported from a
 * sibling because sharing a composition root would share its transport
 * dependency — one application, one root per process.
 */
export const OrderTemporalWorker = Module("OrderTemporalWorker")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    FulfillmentModule,
    ActivitiesModule,
    temporal({
      contract: orderContract,
      activities: OrderActivities,
      workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
    }),
  ],
  exports: [TemporalRuntime],
});
