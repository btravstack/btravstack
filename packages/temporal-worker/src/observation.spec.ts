import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the worker's observations", () => {
  it("observes an activity ATTEMPT, dimensioned by activity type", async ({ serveObserved }) => {
    // GIVEN the worker over an observer that records — which is all a graph
    // does to be observed: the starter asks for no ports
    const { client, taskQueue, taken } = await serveObserved();

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-observed-1",
      args: ["x"],
    });
    await vi.waitUntil(() => taken().length === 1);

    // THEN the dimension is the activity TYPE, which the contract bounds. The
    // workflow id is not among them and must not be: it is unbounded, and it is
    // already the unit's `traceId`, which is where an unbounded value belongs
    expect(taken()[0]).toEqual({
      component: "temporal",
      name: "attempt",
      attributes: { activity: "echo" },
      outcome: "ok",
    });
  });

  it("settles an attempt nobody modelled as an error, not as a silence", async ({
    serveObserved,
  }) => {
    // GIVEN the same composition over an activity that defects
    const { client, taskQueue, taken } = await serveObserved(true);

    // WHEN a workflow drives one attempt — the contract caps retries at one, so
    // exactly one attempt is observed
    await client.workflow
      .execute("runEcho", { taskQueue, workflowId: "wf-observed-2", args: ["x"] })
      .catch(() => undefined);
    await vi.waitUntil(() => taken().length === 1);

    // THEN it settles as an error, per ATTEMPT — the workflow's own count would
    // hide exactly the retries worth alerting on
    expect(taken()[0]).toEqual({
      component: "temporal",
      name: "attempt",
      attributes: { activity: "echo" },
      outcome: "error",
    });
  });
});
