import {
  tagPatterns,
  WORKFLOW_RESULT_ERROR_TAGS,
  WORKFLOW_START_ERROR_TAGS,
} from "@temporal-contract/client";
import { describe, expect, vi } from "vitest";

import { OrderTemporalModule } from "./module.js";
import { it } from "./test-fixtures.js";

describe("temporalWorkerRuntime", () => {
  it("places an order through a workflow and an activity", async ({ serve }) => {
    // GIVEN the same composition the API and the queue worker boot —
    // `ApplicationModule` and `PersistenceModule`, unchanged — under a Temporal
    // worker instead
    const { client } = await serve(OrderTemporalModule);

    // WHEN a workflow execution is driven to completion
    // THEN the order came back through a real Workflow Task, a real Activity
    // Task, and the use case behind both
    await expect(
      client.executeWorkflow("placeOrder", {
        workflowId: "wf-place-1",
        args: { orderId: "o-1", quantity: 2 },
      }),
    ).toBeOkWith({ id: "o-1", quantity: 2 });
  });

  it("hands the client the DuplicateOrder the API answers CONFLICT for, as a typed contract error", async ({
    serve,
  }) => {
    // GIVEN an order already placed by a first execution
    const { client } = await serve(OrderTemporalModule);

    // WHEN a second execution asks for the same order id — chained, so the
    // first execution's result is consumed and a failure there cannot be
    // mistaken for the duplicate
    const outcome = await client
      .executeWorkflow("placeOrder", {
        workflowId: "wf-dup-1",
        args: { orderId: "o-1", quantity: 2 },
      })
      .flatMap(() =>
        client.executeWorkflow("placeOrder", {
          workflowId: "wf-dup-2",
          args: { orderId: "o-1", quantity: 2 },
        }),
      )
      .match({
        ok: () => "WRONGLY PLACED",
        // THEN the load-bearing assertion of this package: the identical `Err`
        // the oRPC runtime turns into an inferable CONFLICT and the queue
        // worker parks is here a **branchable value at the client**, rehydrated
        // by name with its payload intact. Folded through an exhaustive match
        // rather than shape-matched, because "the client can branch on it" is
        // the claim and this is what branching on it looks like.
        errCases: (matcher) =>
          matcher
            .with({ errorName: "InvalidQuantity" }, (error) => `invalid:${error.data.id}`)
            .with({ errorName: "OrderAlreadyPlaced" }, (error) => `conflict:${error.data.id}`)
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: (cause) => `defect:${String(cause)}`,
      });

    expect(outcome).toBe("conflict:o-1");
  });

  it("hands the client the InvalidQuantity the domain rejects, by its own name", async ({
    serve,
  }) => {
    // GIVEN a quantity the domain invariant rejects
    const { client } = await serve(OrderTemporalModule);

    // WHEN the execution runs
    const outcome = await client
      .executeWorkflow("placeOrder", {
        workflowId: "wf-invalid-1",
        args: { orderId: "o-1", quantity: 0 },
      })
      .match({
        ok: () => "WRONGLY PLACED",
        errCases: (matcher) =>
          matcher
            .with({ errorName: "InvalidQuantity" }, (error) => `invalid:${error.data.id}`)
            .with({ errorName: "OrderAlreadyPlaced" }, (error) => `conflict:${error.data.id}`)
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: (cause) => `defect:${String(cause)}`,
      });

    // THEN it arrives under its own name rather than the duplicate's or an
    // opaque failure, carrying the order it was about
    expect(outcome).toBe("invalid:o-1");
  });

  it("lets Temporal retry an unmodelled failure, which is what a retry policy is for", async ({
    serve,
    unmodelled,
  }) => {
    // GIVEN a repository whose failure nobody modelled, so it is a `Defect`
    const { client } = await serve(unmodelled.module);

    // WHEN an execution reaches it and runs out of attempts
    const placed = await client.executeWorkflow("placeOrder", {
      workflowId: "wf-defect-1",
      args: { orderId: "o-1", quantity: 1 },
    });

    // THEN the third channel takes a third route again, and this time the
    // platform owns it: an unnamed failure is retried up to the contract's
    // `maximumAttempts` of 3, where the two named ones are declared
    // `nonRetryable` and are asked exactly once. The queue worker hand-rolls
    // this with an attempt budget; here it is a line of contract.
    expect({ failed: placed.isErr(), attempts: unmodelled.attempts() }).toEqual({
      failed: true,
      attempts: 3,
    });
  });

  it("publishes the task queue and namespace it polls on Serving.info", async ({ serve }) => {
    // GIVEN a worker on a task queue of this test's own
    const { app } = await serve(OrderTemporalModule);

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN the same channel the API publishes `{ port, prefix }` on and the
    // queue worker `{ queue, concurrency }` carries the pair that identifies a
    // Temporal worker — and no two of the three shapes share a field
    await expect(info).toBeOkWith({
      taskQueue: expect.stringMatching(/^orders-\d+$/u),
      namespace: "default",
    });
  });

  it("runs each workflow execution in its own unit, with its own trace id", async ({
    serve,
    tapped,
  }) => {
    // GIVEN the real graph with the very `Logger` instance the use cases write to
    const { client } = await serve(tapped.module);

    // WHEN two executions are driven to completion — chained, so neither result
    // is dropped
    const placed = await client
      .executeWorkflow("placeOrder", {
        workflowId: "wf-trace-1",
        args: { orderId: "o-1", quantity: 1 },
      })
      .flatMap(() =>
        client.executeWorkflow("placeOrder", {
          workflowId: "wf-trace-2",
          args: { orderId: "o-2", quantity: 1 },
        }),
      );

    // THEN two executions, two units, two distinct trace ids — each the workflow
    // id its activity ran under, and never the out-of-unit `[-]`. The unit id is
    // Temporal's own task token, unique per *attempt*; the workflow id is the
    // correlation id, which deliberately is not.
    expect(placed.map(() => tapped.traces())).toBeOkWith(["[wf-trace-1]", "[wf-trace-2]"]);
  });

  it("lets an in-flight activity finish while draining", async ({ serve, gate }) => {
    // GIVEN an activity held open inside the repository. `startWorkflow`, not
    // `executeWorkflow`: a drained worker stops polling Workflow Tasks too, so
    // the execution never reaches a terminal state and awaiting its result would
    // hang the test on a fact that is not under test.
    const { app, client } = await serve(gate.module);
    const started = client.startWorkflow("placeOrder", {
      workflowId: "wf-drain-1",
      args: { orderId: "o-1", quantity: 1 },
    });
    await gate.arrived;

    // WHEN the drain starts and the activity is released only once the phase
    // moved. `vi.waitUntil` synchronises rather than asserts — the drain samples
    // `inFlightAtStart` in the same synchronous turn that advances the phase, so
    // releasing afterwards is what makes the report exact rather than racy.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the payoff, and the first time the kernel's drain contract meets a
    // real worker's shutdown semantics: `worker.shutdown()` stops polling for
    // new tasks the instant it is called, `run()` resolves only once the
    // in-flight activity has finished, and the kernel's own accounting agrees —
    // nothing abandoned. Read through the started execution so its `Result` is
    // consumed rather than dropped.
    const report = await started.flatMap(() => app.exited);

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  it("releases the runtime at the kernel's deadline when an activity will not finish", async ({
    serve,
    gate,
  }) => {
    // GIVEN an activity held open with nothing to release it, and a drain
    // budget of a tenth of a second — so `worker.run()` cannot settle inside
    // it and the only way out is the deadline signal
    const { app, client } = await serve(gate.module, { drainTimeoutMs: 100 });
    const started = client.startWorkflow("placeOrder", {
      workflowId: "wf-stuck-1",
      args: { orderId: "o-1", quantity: 1 },
    });
    await gate.arrived;

    // WHEN the drain runs out of time
    app.requestDrain();
    const askedAt = Date.now();
    const report = await started.flatMap(() => app.exited);
    const elapsedMs = Date.now() - askedAt;

    // THEN the kernel's exit is not held hostage by a worker that cannot stop:
    // the activity is reported abandoned and the process is released on the
    // kernel's own deadline rather than on Temporal's 30-second `forceAfter`,
    // which is what `Serving.drain(signal)` promises the kernel.
    expect(report.map((exit) => ({ drain: exit.drain, promptly: elapsedMs < 5_000 }))).toBeOkWith({
      drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 },
      promptly: true,
    });
  });
});
