import { Client } from "@temporalio/client";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { temporalNamespace } from "./index.js";

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
      attemptSpanMs: 0,
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

  it("keeps attaching while Docker has yet to list the winner's container", async ({
    runServer,
  }) => {
    // GIVEN a winner whose container Docker lists only after a dozen refusals, several seconds on
    const refusals = Array.from({ length: 12 }, () => ({ refused: 409 }));

    // WHEN this run starts
    const { outcome, events } = await runServer({}, [...refusals, "starts"]);

    // THEN it waited the refusals out and attached
    expect({ outcome, events }).toEqual({
      outcome: "ok, left running",
      events: [...refusals.map(() => "refused 409"), "start"],
    });
  });

  it("fails the run with Docker's refusal once the startup budget runs out", async ({
    runServer,
  }) => {
    // GIVEN a name Docker refuses for longer than a 5 s budget
    const refusals = Array.from({ length: 100 }, () => ({ refused: 409 }));

    // WHEN the run starts
    const { outcome, attemptSpanMs } = await runServer({ startupTimeoutMs: 5_000 }, refusals);

    // THEN it retried for the budget, and no longer
    expect({ outcome, seconds: Math.round(attemptSpanMs / 1_000) }).toEqual({
      outcome: "failed: HTTP code 409",
      seconds: 5,
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

describe("temporalNamespace", () => {
  it("answers a namespace a global setup registered, usable at once", async ({ run }) => {
    // GIVEN a workflow started, with no worker, in the namespace the run's global setup registered
    const workflowId = `run-${run.options.namespace}`;
    await run.workflow.start("unserved", { taskQueue: "nobody", workflowId, args: [] });

    // WHEN it is described there
    const described = run.workflow.getHandle(workflowId).describe();

    // THEN the server holds it in that namespace
    await expect(described).resolves.toMatchObject({
      workflowId,
      status: { name: "RUNNING" },
    });
  });

  it("keeps two runs registering at once apart, down to the tasks they poll", async ({
    temporal,
    connection,
    pollOnce,
  }) => {
    // GIVEN two runs registering on the shared server at once, and a workflow started in the first's namespace
    const [first, second] = await Promise.all([
      temporalNamespace(temporal.TEMPORAL_ADDRESS, "run"),
      temporalNamespace(temporal.TEMPORAL_ADDRESS, "run"),
    ]);
    const queue = `shared-${first}`;
    const workflowId = `first-${first}`;
    await new Client({ connection, namespace: first }).workflow.start("unserved", {
      taskQueue: queue,
      workflowId,
      args: [],
    });

    // WHEN each run polls the queue both their workers would serve
    const [polledByFirst, polledBySecond] = await Promise.all([
      pollOnce(first, queue),
      pollOnce(second, queue),
    ]);

    // THEN the names differ, and only the first run's poller receives its task
    expect({ distinct: first !== second, polledByFirst, polledBySecond }).toEqual({
      distinct: true,
      polledByFirst: workflowId,
      polledBySecond: undefined,
    });
  });

  it("names the namespace that never became usable, with the server's last answer", async ({
    neverUsable,
    onFakeClock,
  }) => {
    // GIVEN a server that registers a namespace but never serves it
    // WHEN a namespace is registered on it
    const { settled, elapsedMs } = await onFakeClock(() => temporalNamespace(neverUsable, "stuck"));

    // THEN it gave up after a minute, naming the namespace
    expect({ settled, seconds: Math.round(elapsedMs / 1_000) }).toEqual({
      settled: {
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(
            /^Temporal namespace stuck-[0-9a-f-]{36} was registered but not usable within 60000 ms$/,
          ),
          cause: expect.objectContaining({ message: "Namespace not found" }),
        }),
      },
      seconds: 60,
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
