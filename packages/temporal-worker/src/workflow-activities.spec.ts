import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("temporal workflow slices", () => {
  it("keeps identical activity keys distinct across contract queues", ({ contractSlices }) => {
    // GIVEN
    const { first, second } = contractSlices;

    // WHEN
    const identities = new Set([first.piece.port.portId, second.piece.port.portId]);

    // THEN
    expect(identities.size).toBe(2);
  });

  it("does not warn when separate contracts reuse an activity key", ({ contractSlices }) => {
    // GIVEN
    const { warnings } = contractSlices;

    // WHEN
    const diagnostics = warnings();

    // THEN
    expect(diagnostics).toEqual([]);
  });

  it("dispatches overlapping keys to their own contract workers", async ({
    contractSlices,
    serveContractSlice,
  }) => {
    // GIVEN
    const [first, second] = await Promise.all([
      serveContractSlice(contractSlices.first),
      serveContractSlice(contractSlices.second),
    ]);

    // WHEN
    const answers = await Promise.all([
      first.client.workflow.execute("runEcho", {
        taskQueue: first.taskQueue,
        workflowId: `first-${first.taskQueue}`,
        args: ["one"],
      }),
      second.client.workflow.execute("runEcho", {
        taskQueue: second.taskQueue,
        workflowId: `second-${second.taskQueue}`,
        args: ["two"],
      }),
    ]);

    // THEN
    expect(answers).toEqual(["first:one", "second:two"]);
  });

  it("serves a record composed from one piece per workflow", async ({ serveSliced, slices }) => {
    // GIVEN a worker whose activities were composed from two slices, one per
    // workflow, both polling the one task queue this process owns
    const { client, taskQueue } = await serveSliced(slices);

    // WHEN the workflow owned by the SECOND slice is executed
    const shouted = client.workflow.execute("runShout", {
      taskQueue,
      workflowId: `shout-${taskQueue}`,
      args: ["hello"],
    });

    // THEN its own piece answered, so every piece was mounted under its key
    await expect(shouted).resolves.toBe("HELLO");
  });

  it("builds each piece from the ports its own provider declared", async ({
    serveSliced,
    slices,
  }) => {
    // GIVEN the same two slices, of which only `runEcho`'s declares `Greeting`
    const { client, taskQueue } = await serveSliced(slices);

    // WHEN the workflow that slice owns runs
    await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `echo-${taskQueue}`,
      args: ["hello"],
    });

    // THEN it closed over the application's own service
    expect(slices.greeting()).toBe("hello");
  });
});
