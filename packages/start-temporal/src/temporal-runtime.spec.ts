import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("temporalRuntime", () => {
  it("publishes the task queue and namespace it polls", async ({ serve }) => {
    // GIVEN a worker polling a queue of this test's own
    const { app, taskQueue } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the pair that identifies a Temporal worker to an operator
    await expect(info).toBeOkWith({ taskQueue, namespace: "default" });
  });

  it("reports a workflow bundle that will not build as Err, not a defect", async ({
    serveBroken,
  }) => {
    // GIVEN a workflows path that cannot be bundled
    const app = await serveBroken();

    // WHEN the application is started
    // THEN it never comes up, and the failure is the kernel's own modeled
    // Err rather than an unmodelled Defect. This is what guards against
    // `createWorker` regressing from `fromPromise(..., qualify)` to
    // `fromSafePromise`: swapping them turns every startup failure into a
    // Defect and changes `runMain`'s exit code from 1 to 70 (verified by
    // temporarily making that swap: the assertion below then fails, naming
    // `Defect([Error: ENOENT ...])` instead of `Err(RuntimeStartFailed)`).
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "temporal" }),
    );
  });

  it("opens one kernel unit per activity attempt", async ({ serve, recorder }) => {
    // GIVEN an activity wrapped for the kernel
    const { client, taskQueue } = await serve(recorder.build);

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-unit-1",
      args: ["x"],
    });

    // THEN the attempt ran inside a unit whose meta identifies it by
    // Temporal's task token, with the workflow id as the correlation id —
    // `id` must be unique per unit, and a workflow id is not: an activity is
    // retried under the same execution.
    expect(recorder.seen()).toEqual([
      { kind: "activity", id: recorder.taskToken(), traceId: "wf-unit-1" },
    ]);
  });
});
