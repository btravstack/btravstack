import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

const IMAGE = "temporalio/temporal:1.9.1";
const SHARED_NAME = /^btravstack-temporal-[0-9a-f]{12}$/;

describe("temporalServer", () => {
  it("provides one development server's address, and leaves the reused server running", async ({
    runServer,
  }) => {
    // GIVEN the default setup, over a container that starts
    // WHEN the run starts and then ends
    const run = await runServer();

    // THEN the address reached the specs, and the named, reused server outlived the run
    expect(run).toEqual({
      outcome: "ok, left running",
      provided: { __BTRAVSTACK_TEMPORAL_ADDRESS__: "localhost:7233" },
      events: ["start"],
      configured: [
        expect.objectContaining({
          image: IMAGE,
          command: ["server", "start-dev", "--ip", "0.0.0.0", "--headless"],
          reuse: true,
          name: expect.stringMatching(SHARED_NAME),
        }),
      ],
    });
  });

  it("stops the server it owns at the run's end", async ({ runServer }) => {
    // GIVEN a setup that owns its server
    // WHEN the run starts and then ends
    const run = await runServer({ reuse: false });

    // THEN an unnamed server was started for this run alone, and stopped
    expect(run).toMatchObject({
      outcome: "ok, stopped",
      events: ["start", "stop"],
      configured: [expect.not.objectContaining({ reuse: true, name: expect.any(String) })],
    });
  });

  it("owns its server when testcontainers' reuse is switched off", async ({ runServer }) => {
    // GIVEN testcontainers told not to reuse anything
    vi.stubEnv("TESTCONTAINERS_REUSE_ENABLE", "false");

    // WHEN the default setup runs
    const run = await runServer();

    // THEN the server is this run's, and it is stopped rather than left behind under a name
    expect(run).toMatchObject({ outcome: "ok, stopped", events: ["start", "stop"] });
  });

  it.for([
    { options: {}, budget: 60_000 },
    { options: { startupTimeoutMs: 600_000 }, budget: 600_000 },
  ])(
    "gives the container a $budget ms startup budget, health check and wait alike",
    async ({ options, budget }, { runServer }) => {
      // GIVEN the setup with these options
      // WHEN it starts the container
      const { configured } = await runServer(options);

      // THEN a loaded host has the whole budget, twice over
      expect(configured).toEqual([
        expect.objectContaining({
          startupTimeoutMs: budget,
          healthCheck: expect.objectContaining({ startPeriod: budget, retries: budget / 1_000 }),
        }),
      ]);
    },
  );

  it("names a server started with other options apart", async ({ runServer }) => {
    // GIVEN two setups whose containers testcontainers would hash differently
    // WHEN each starts
    const names = [
      ...(await runServer()).configured,
      ...(await runServer({ startupTimeoutMs: 600_000 })).configured,
    ].map(({ name }) => name);

    // THEN neither can take the other's name
    expect({ names, distinct: new Set(names).size }).toEqual({
      names: [expect.stringMatching(SHARED_NAME), expect.stringMatching(SHARED_NAME)],
      distinct: 2,
    });
  });

  it.for([409, 304])(
    "attaches to a concurrent run's server when Docker answers %i",
    async (status, { runServer }) => {
      // GIVEN another process that won the name first
      // WHEN this run starts
      const { outcome, events, configured } = await runServer({}, [{ refused: status }, "starts"]);

      // THEN the second attempt attached, under the same name
      expect({ outcome, events, names: [...new Set(configured.map(({ name }) => name))] }).toEqual({
        outcome: "ok, left running",
        events: [`refused ${String(status)}`, "start"],
        names: [expect.stringMatching(SHARED_NAME)],
      });
    },
  );

  it("fails the run once a name stays refused", async ({ runServer }) => {
    // GIVEN a name Docker refuses on every attempt
    const refusals = Array.from({ length: 10 }, () => ({ refused: 409 }));

    // WHEN the run starts
    const run = await runServer({}, refusals);

    // THEN it gave up after ten attempts, with Docker's refusal
    expect(run).toMatchObject({
      outcome: "failed: HTTP code 409",
      events: refusals.map(() => "refused 409"),
    });
  });

  it("fails the run at once on a failure that is not a race", async ({ runServer }) => {
    // GIVEN a container that never becomes healthy
    // WHEN the run starts
    const run = await runServer({}, [{ failed: `${IMAGE} is unhealthy` }, "starts"]);

    // THEN the failure is the run's, after one attempt
    expect(run).toMatchObject({
      outcome: `failed: ${IMAGE} is unhealthy`,
      configured: [expect.anything()],
    });
  });
});

describe("temporalEnvironment", () => {
  it("answers a namespace this file can start workflows in", async ({ temporal, client }) => {
    // GIVEN a workflow started in the fixture's namespace, with no worker
    const workflowId = `env-${temporal.TEMPORAL_NAMESPACE}`;
    await client.workflow.start("unserved", { taskQueue: "nobody", workflowId, args: [] });

    // WHEN it is described there
    const described = client.workflow.getHandle(workflowId).describe();

    // THEN the server holds it in that namespace
    await expect(described).resolves.toMatchObject({
      workflowId,
      status: { name: "RUNNING" },
    });
  });

  it("keeps this file's workflows out of the server's default namespace", async ({
    temporal,
    client,
    foreign,
  }) => {
    // GIVEN a workflow started in the fixture's namespace
    const workflowId = `isolated-${temporal.TEMPORAL_NAMESPACE}`;
    await client.workflow.start("unserved", { taskQueue: "nobody", workflowId, args: [] });

    // WHEN the same id is described in `default`
    const elsewhere = foreign.workflow.getHandle(workflowId).describe();

    // THEN `default` has never heard of it
    await expect(elsewhere).rejects.toMatchObject({ name: "WorkflowNotFoundError" });
  });
});
