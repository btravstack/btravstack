import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the worker's RED metrics", () => {
  it("counts an activity ATTEMPT and times it, dimensioned by activity type", async ({
    serveMetered,
  }) => {
    // GIVEN the default composition — `instrumented` is on unless a root says
    // otherwise — with a meter that records
    const { client, taskQueue, taken } = await serveMetered();

    // WHEN a workflow drives one attempt
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: "wf-metrics-1",
      args: ["x"],
    });
    await vi.waitUntil(() => taken().length === 2);

    // THEN both instruments carry the activity TYPE, which the contract bounds.
    // The workflow id is not among them and must not be: it is unbounded, and
    // it is already the unit's `traceId`, which is where an unbounded value
    // belongs
    expect(taken().map(({ instrument, attributes }) => ({ instrument, attributes }))).toEqual([
      {
        instrument: "btravstack.temporal.activity.attempts",
        attributes: { activity: "echo", outcome: "ok" },
      },
      {
        instrument: "btravstack.temporal.activity.duration",
        attributes: { activity: "echo", outcome: "ok" },
      },
    ]);
  });

  it("counts an attempt nobody modelled as an error, not as a silence", async ({
    serveMetered,
  }) => {
    // GIVEN the same composition over an activity that defects
    const { client, taskQueue, taken } = await serveMetered(true);

    // WHEN a workflow drives one attempt — the contract caps retries at one, so
    // exactly one attempt is recorded
    await client.workflow
      .execute("runEcho", { taskQueue, workflowId: "wf-metrics-2", args: ["x"] })
      .catch(() => undefined);
    await vi.waitUntil(() => taken().length === 2);

    // THEN the errors half of RED sees it. Per ATTEMPT, not per activity: the
    // workflow's own count would hide exactly the retries worth alerting on
    expect(taken()[0]).toEqual({
      instrument: "btravstack.temporal.activity.attempts",
      value: 1,
      attributes: { activity: "echo", outcome: "error" },
    });
  });
});
