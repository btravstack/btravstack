import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("temporal workflow slices", () => {
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
