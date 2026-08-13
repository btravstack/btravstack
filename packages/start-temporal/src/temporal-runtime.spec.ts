import { describe, expect, vi } from "vitest";

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

  it("reports an activities builder that throws as Err, not a defect", async ({ serveBroken }) => {
    // GIVEN a builder that throws the way `declareActivitiesHandler` does on a
    // contract it cannot satisfy — two implementations for one activity name,
    // or an implementation the contract never declared
    const app = await serveBroken(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject under test; `declareActivitiesHandler` has no Result-returning form to mint it with
      throw new Error("two implementations for one activity name");
    });

    // WHEN the application is started
    // THEN the builder's throw lands in the kernel's modeled channel rather
    // than on the defect one, which is the difference between `runMain`
    // exiting 1 and exiting 70. It is the reason `options.activities(host)` is
    // called inside `fromThrowable` rather than before the qualified chain.
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "temporal" }),
    );
  });

  it("opens one kernel unit per activity attempt", async ({ serve, contractSeam }) => {
    // GIVEN activities declared through temporal-contract with the middleware
    const { client, taskQueue } = await serve(contractSeam.build);

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-unit-1",
      args: ["x"],
    });

    // THEN the attempt ran inside a unit whose meta identifies it by Temporal's
    // task token, with the workflow id as the correlation id — `id` must be
    // unique per unit, and a workflow id is not: an activity is retried under
    // the same execution.
    expect(contractSeam.seen()).toEqual([
      { kind: "activity", id: contractSeam.taskToken(), traceId: "wf-unit-1" },
    ]);
  });

  it("injects the application context through the contract's own channel", async ({
    serve,
    contractSeam,
  }) => {
    // GIVEN the same wiring
    const { client, taskQueue } = await serve(contractSeam.build);

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-ctx-1",
      args: ["x"],
    });

    // THEN the implementation reached the DI graph without the package
    // inventing a channel of its own — which is what makes the seam cost one
    // line
    expect(contractSeam.greeting()).toBe("hello");
  });

  it("lets an in-flight activity finish while draining", async ({ serve, gate }) => {
    // GIVEN an activity held open inside the application. `start`, not
    // `execute`: a drained worker stops polling Workflow Tasks too, so the
    // execution never reaches a terminal state and awaiting its result would
    // hang the test on a fact that is not under test.
    const { app, client, taskQueue } = await serve(gate.build);
    await client.workflow.start("runEcho", {
      taskQueue,
      workflowId: "wf-drain-1",
      args: ["x"],
    });
    await gate.arrived;

    // WHEN the drain starts and the activity is released once the phase moved.
    // `vi.waitUntil` synchronises rather than asserts — the drain samples
    // `inFlightAtStart` in the same synchronous turn that advances the phase.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the kernel counted it as one unit that COMPLETED, through a real
    // Workflow-Task / Activity-Task loop
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });

  it("releases the kernel at its own deadline, not Temporal's", async ({ serve, gate }) => {
    // GIVEN an activity that never finishes, and a drain with no time to give it
    const { app, client, taskQueue } = await serve(gate.build, { drainTimeoutMs: 100 });
    await client.workflow.start("runEcho", {
      taskQueue,
      workflowId: "wf-hung-1",
      args: ["x"],
    });
    await gate.arrived;

    // WHEN the drain runs out of time
    const askedAt = Date.now();
    app.requestDrain();
    const report = await app.exited;

    // THEN the exit is not held hostage by a worker that cannot stop: the
    // activity is reported abandoned and the process is released on the
    // kernel's deadline rather than Temporal's `shutdownForceTime`, which is
    // what `Serving.drain(signal)` promises the kernel.
    expect(
      report.map((exit) => ({ drain: exit.drain, promptly: Date.now() - askedAt < 5_000 })),
    ).toBeOkWith({
      drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 },
      promptly: true,
    });
  });
});
