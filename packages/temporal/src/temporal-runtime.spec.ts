import { describe, expect, vi } from "vitest";

import { it, undeclared } from "./test-fixtures.js";

describe("temporal", () => {
  it("publishes the task queue and namespace it polls", async ({ serve }) => {
    // GIVEN a worker polling a queue of this test's own
    const { app, taskQueue } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the pair that identifies a Temporal worker to an operator
    await expect(info).toBeOkWith({ taskQueue, namespace: "default" });
  });

  it("binds TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE from the environment when nothing is pinned", async ({
    env,
    serve,
    configured,
  }) => {
    // GIVEN an environment naming both, and a starter pinning neither
    await serve({
      env: { TEMPORAL_ADDRESS: env.address, TEMPORAL_NAMESPACE: "default" },
      tap: configured.tap,
    });

    // WHEN the graph has bound `TemporalConfig`
    // THEN both came from the environment
    expect(configured.bound()).toEqual({ address: env.address, namespace: "default" });
  });

  it("pins what it is given and reads the rest from the environment", async ({
    env,
    serve,
    configured,
  }) => {
    // GIVEN the address pinned and the namespace left to the environment
    await serve({ address: env.address, env: {}, tap: configured.tap });

    // WHEN the graph has bound `TemporalConfig`
    // THEN the pin won for the address and the environment's default for the rest
    expect(configured.bound()).toEqual({ address: env.address, namespace: "default" });
  });

  it("reads nothing from the environment when both are pinned", async ({
    env,
    serve,
    configured,
  }) => {
    // GIVEN both pinned, over an environment that would be a configuration
    // error if it were read — a blank variable is never an absent one
    await serve({
      address: env.address,
      namespace: "default",
      env: { TEMPORAL_ADDRESS: "" },
      tap: configured.tap,
    });

    // WHEN the graph has bound `TemporalConfig`
    // THEN the pins are what it holds, and the environment was never consulted
    expect(configured.bound()).toEqual({ address: env.address, namespace: "default" });
  });

  it("fails startup with ConfigInvalid for TemporalConfig when TEMPORAL_NAMESPACE is blank", async ({
    env,
    serveBroken,
  }) => {
    // GIVEN a namespace that is set but empty
    const app = await serveBroken({
      env: { TEMPORAL_ADDRESS: env.address, TEMPORAL_NAMESPACE: " " },
    });

    // WHEN the application is started
    // THEN the failure names the port and the variable, on the modeled channel
    await expect(app.exited).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        port: "TemporalConfig",
        issues: [{ message: "is set but empty", path: ["TEMPORAL_NAMESPACE"] }],
      }),
    );
  });

  it("reports a Temporal service it cannot reach as TemporalUnreachable, not a defect", async ({
    serveBroken,
  }) => {
    // GIVEN an address nothing listens on
    const app = await serveBroken({ env: { TEMPORAL_ADDRESS: "127.0.0.1:1" } });

    // WHEN the application is started
    // THEN the connection failure is the starter's own modeled Err, naming the
    // address an operator would go and check
    await expect(app.exited).toBeErrTagged(
      "TemporalUnreachable",
      expect.objectContaining({ address: "127.0.0.1:1" }),
    );
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

  it("reports an activities record the contract cannot satisfy as Err, not a defect", async ({
    serveBroken,
  }) => {
    // GIVEN an implementation the contract never declared, which is one of the
    // things `declareActivitiesHandler` throws on
    const app = await serveBroken({ activities: undeclared });

    // WHEN the application is started
    // THEN the throw lands in the kernel's modeled channel rather than on the
    // defect one, which is the difference between `runMain` exiting 1 and
    // exiting 70. It is the reason `declareActivitiesHandler` is called inside
    // `fromThrowable` rather than before the qualified chain.
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "temporal" }),
    );
  });

  it("opens one kernel unit per activity attempt", async ({ serve, contractSeam }) => {
    // GIVEN activities that read the ambient record from inside the attempt
    const { client, taskQueue } = await serve({ activities: contractSeam.activities });

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-unit-1",
      args: ["x"],
    });

    // THEN the attempt ran inside exactly one unit, and the workflow id is its
    // correlation id — `traceId` was supplied rather than left to default to
    // the unit's own `id`, which is the task token: an activity is retried
    // under the same execution, so a workflow id could never be the id
    expect(contractSeam.seen().map((unit) => unit?.traceId)).toEqual(["wf-unit-1"]);
  });

  it("builds the activities from the graph, closing over the services their provider declared", async ({
    serve,
    contractSeam,
  }) => {
    // GIVEN the same wiring: the activities provider depends on `Greeting`
    const { client, taskQueue } = await serve({ activities: contractSeam.activities });

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-ctx-1",
      args: ["x"],
    });

    // THEN the implementation reached the application's service the way every
    // other service does — through its own provider, with nothing injected
    // by the runtime and nothing resolved from a context
    expect(contractSeam.greeting()).toBe("hello");
  });

  it("lets an in-flight activity finish while draining", async ({ serve, gate }) => {
    // GIVEN an activity held open inside the application. `start`, not
    // `execute`: a drained worker stops polling Workflow Tasks too, so the
    // execution never reaches a terminal state and awaiting its result would
    // hang the test on a fact that is not under test.
    const { app, client, taskQueue } = await serve({ activities: gate.activities });
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

  it("hands the activity the unit's own AbortSignal, through the ambient record", async ({
    serve,
    deadline,
  }) => {
    // GIVEN an activity waiting on `currentUnit()?.signal` — the only route to
    // it here, since the middleware's work callback is `next()` and an
    // activity has no parameter to receive one through. Temporal's own
    // `Context.current().cancellationSignal` is a different clock: it fires on
    // `shutdownGraceTime`, which this test never reaches.
    const { app, client, taskQueue } = await serve({
      activities: deadline.activities,
      drainTimeoutMs: 100,
    });
    await client.workflow.start("runEcho", {
      taskQueue,
      workflowId: "wf-deadline-1",
      args: ["x"],
    });
    await deadline.arrived;

    // WHEN the drain runs out of time for it
    app.requestDrain();
    const report = await app.exited;

    // THEN the activity saw the kernel's abort, and the unit is reported
    // abandoned — one deadline, observable from inside the work
    expect(
      report.map((exit) => ({ abandoned: exit.drain?.abandoned, sawAbort: deadline.sawAbort() })),
    ).toBeOkWith({ abandoned: 1, sawAbort: true });
  });

  it("releases the kernel at its own deadline, not Temporal's", async ({ serve, gate }) => {
    // GIVEN an activity that never finishes, and a drain with no time to give it
    const { app, client, taskQueue } = await serve({
      activities: gate.activities,
      drainTimeoutMs: 100,
    });
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
