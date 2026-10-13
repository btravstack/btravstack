import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("temporalServer", () => {
  it("provides the server's address, and stops what it started in reverse at teardown", async ({
    runServer,
  }) => {
    // GIVEN the global setup, over containers that start
    // WHEN the run starts and then ends
    const run = await runServer();

    // THEN the address reached the specs, and nothing outlived the run
    expect(run).toMatchObject({
      outcome: "ok",
      provided: { __BTRAVSTACK_TEMPORAL_ADDRESS__: "localhost:7233" },
      events: [
        "start network",
        "start postgres:18.1",
        "start temporalio/auto-setup:1.29.1",
        "stop temporalio/auto-setup:1.29.1",
        "stop postgres:18.1",
        "stop network",
      ],
    });
  });

  it.for([
    { options: {}, budget: 300_000 },
    { options: { startupTimeoutMs: 600_000 }, budget: 600_000 },
  ])(
    "gives both containers a $budget ms startup budget, health check and wait alike",
    async ({ options, budget }, { runServer }) => {
      // GIVEN the global setup with these options
      // WHEN it starts the containers
      const { configured } = await runServer(options);

      // THEN schema creation on a loaded host has the whole budget, twice over
      const budgeted = {
        startupTimeoutMs: budget,
        healthCheck: expect.objectContaining({ startPeriod: budget, retries: budget / 1_000 }),
      };
      expect(configured).toEqual([
        expect.objectContaining({ image: "postgres:18.1", ...budgeted }),
        expect.objectContaining({ image: "temporalio/auto-setup:1.29.1", ...budgeted }),
      ]);
    },
  );

  it("stops what already started when a later container fails, and fails the run", async ({
    runServer,
  }) => {
    // GIVEN a Temporal container that never becomes healthy
    // WHEN the setup runs
    const run = await runServer({}, true);

    // THEN the failure is the run's, and the network and database are gone
    expect(run).toMatchObject({
      outcome: "failed: temporalio/auto-setup:1.29.1 is unhealthy",
      events: ["start network", "start postgres:18.1", "stop postgres:18.1", "stop network"],
    });
  });

  it("still stops the database and network when the Temporal container will not stop", async ({
    runServer,
  }) => {
    // GIVEN a Temporal container whose stop fails
    // WHEN the run starts and then ends
    const run = await runServer({}, false, ["temporalio/auto-setup:1.29.1"]);

    // THEN every stop was attempted, and the teardown reports the one that failed
    expect(run).toMatchObject({
      outcome:
        "teardown failed: [temporal-worker] the Temporal test server did not stop cleanly / temporalio/auto-setup:1.29.1 did not stop",
      events: [
        "start network",
        "start postgres:18.1",
        "start temporalio/auto-setup:1.29.1",
        "stop temporalio/auto-setup:1.29.1",
        "stop postgres:18.1",
        "stop network",
      ],
    });
  });

  it("keeps the startup failure when cleaning up after it fails too", async ({ runServer }) => {
    // GIVEN a Temporal container that never becomes healthy, and a database that will not stop
    // WHEN the setup runs
    const run = await runServer({}, true, ["postgres:18.1"]);

    // THEN the network was still stopped, and the startup failure leads the report
    expect(run).toMatchObject({
      outcome:
        "failed: [temporal-worker] the Temporal test server failed to start, and what had started did not stop cleanly / temporalio/auto-setup:1.29.1 is unhealthy / postgres:18.1 did not stop",
      events: ["start network", "start postgres:18.1", "stop postgres:18.1", "stop network"],
    });
  });
});

describe("temporalEnvironment", () => {
  it("boots a worker from the environment alone, in this file's own namespace", async ({
    temporal,
    serve,
  }) => {
    // GIVEN a worker whose only configuration is the fixture's environment
    const { client, taskQueue } = await serve({ env: { ...temporal } });

    // WHEN a workflow is run in that namespace
    const echoed = client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `env-${taskQueue}`,
      args: ["hello"],
    });

    // THEN the worker served it
    await expect(echoed).resolves.toBe("hello");
  });

  it("leaves a workflow started in another namespace unserved", async ({ serve, foreign }) => {
    // GIVEN a worker polling a queue in this file's namespace
    const { taskQueue } = await serve();

    // WHEN the same workflow is started on the same queue in `default`
    const elsewhere = foreign.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `foreign-${taskQueue}`,
      args: ["hello"],
      workflowExecutionTimeout: "2 seconds",
    });

    // THEN nothing picked it up before it timed out
    await expect(elsewhere).rejects.toMatchObject({ name: "WorkflowFailedError" });
  });
});
