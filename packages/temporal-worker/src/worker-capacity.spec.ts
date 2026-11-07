import { Config } from "@btravstack/config";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { capacityFields, validateCapacity } from "./worker-capacity.js";

describe("worker capacity", () => {
  it("should leave absent capacity options to the actual SDK defaults", async ({
    serve,
    created,
  }) => {
    // GIVEN
    await serve();
    // WHEN
    const input = created[0]!.input;
    // THEN
    expect(Object.keys(input).filter((key) => key.startsWith("max"))).toEqual([]);
  });

  it("should bind all three environment controls to the actual worker", async ({
    server,
    serve,
    created,
  }) => {
    // GIVEN
    await serve({
      env: {
        TEMPORAL_ADDRESS: server.address,
        TEMPORAL_NAMESPACE: server.namespace,
        TEMPORAL_MAX_CACHED_WORKFLOWS: "4",
        TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS: "2",
        TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS: "1",
      },
    });
    // WHEN
    const { input, worker } = created[0]!;
    // THEN
    expect({
      cache: worker.options.maxCachedWorkflows,
      tuner: worker.options.tuner,
      workflowSlots: input.maxConcurrentWorkflowTaskExecutions,
      activitySlots: input.maxConcurrentActivityTaskExecutions,
    }).toEqual({
      cache: 4,
      workflowSlots: 2,
      activitySlots: 1,
      tuner: expect.objectContaining({
        workflowTaskSlotSupplier: { type: "fixed-size", numSlots: 2 },
        activityTaskSlotSupplier: { type: "fixed-size", numSlots: 1 },
      }),
    });
  });

  it("should pin capacity over invalid environment values", async ({ server, serve, created }) => {
    // GIVEN
    await serve({
      maxCachedWorkflows: 0,
      maxConcurrentWorkflowTaskExecutions: 1,
      maxConcurrentActivityTaskExecutions: 2,
      env: {
        TEMPORAL_ADDRESS: server.address,
        TEMPORAL_NAMESPACE: server.namespace,
        TEMPORAL_MAX_CACHED_WORKFLOWS: "invalid",
        TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS: "",
        TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS: "0",
      },
    });
    // WHEN
    const { input, worker } = created[0]!;
    // THEN
    expect({
      cache: worker.options.maxCachedWorkflows,
      tuner: worker.options.tuner,
      workflowSlots: input.maxConcurrentWorkflowTaskExecutions,
      activitySlots: input.maxConcurrentActivityTaskExecutions,
    }).toEqual({
      cache: 0,
      workflowSlots: 1,
      activitySlots: 2,
      tuner: expect.objectContaining({
        workflowTaskSlotSupplier: { type: "fixed-size", numSlots: 1 },
        activityTaskSlotSupplier: { type: "fixed-size", numSlots: 2 },
      }),
    });
  });

  it("should execute queued activities within the configured single slot", async ({
    serve,
    gate,
    created,
  }) => {
    // GIVEN
    const { client, taskQueue } = await serve({
      activities: gate.activities,
      maxConcurrentActivityTaskExecutions: 1,
    });
    const handles = await Promise.all(
      ["first", "second", "third"].map((value) =>
        client.workflow.start("runEcho", {
          taskQueue,
          workflowId: `${taskQueue}-${value}`,
          args: [value],
        }),
      ),
    );
    await gate.arrived;
    await vi.waitUntil(
      async () =>
        (await Promise.all(handles.map((handle) => handle.fetchHistory()))).every((history) =>
          history.events?.some((event) => event.activityTaskScheduledEventAttributes !== undefined),
        ),
      { timeout: 10_000 },
    );
    // WHEN
    const inFlight = created[0]!.worker.getStatus().numInFlightActivities;
    gate.release();
    const results = await Promise.all(handles.map((handle) => handle.result()));
    // THEN
    expect({ inFlight, results }).toEqual({ inFlight: 1, results: ["first", "second", "third"] });
  });

  it("should replay and complete workflows after cache eviction", async ({
    serve,
    gate,
    created,
  }) => {
    // GIVEN
    const { client, taskQueue } = await serve({
      activities: gate.activities,
      maxCachedWorkflows: 2,
      maxConcurrentWorkflowTaskExecutions: 2,
    });
    const handles = await Promise.all(
      ["first", "second", "third"].map((value) =>
        client.workflow.start("runEcho", {
          taskQueue,
          workflowId: `${taskQueue}-${value}`,
          args: [value],
        }),
      ),
    );
    await vi.waitUntil(() => created[0]!.worker.getStatus().numInFlightActivities === 3, {
      timeout: 10_000,
    });
    await vi.waitUntil(() => created[0]!.worker.getStatus().numCachedWorkflows <= 2, {
      timeout: 10_000,
    });
    const cached = created[0]!.worker.getStatus().numCachedWorkflows;
    // WHEN
    gate.release();
    const results = await Promise.all(handles.map((handle) => handle.result()));
    // THEN
    expect({ evicted: cached < handles.length, results }).toEqual({
      evicted: true,
      results: ["first", "second", "third"],
    });
  });

  it.each(["", "NaN", "1.5", "-1", "9007199254740992"])(
    "should reject malformed capacity values %j",
    async (value) => {
      // GIVEN
      const schema = Config.object(capacityFields({}));
      // WHEN
      const result = Config.parse(
        "TemporalConfig",
        schema,
      )({ TEMPORAL_MAX_CACHED_WORKFLOWS: value });
      // THEN
      await expect(result).toBeErrTagged("ConfigInvalid");
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "should reject invalid pinned execution capacity %j",
    async (value) => {
      // GIVEN
      const schema = Config.object(capacityFields({ maxConcurrentActivityTaskExecutions: value }));
      // WHEN
      const result = Config.parse("TemporalConfig", schema)({});
      // THEN
      await expect(result).toBeErrTagged("ConfigInvalid");
    },
  );

  it.each([
    { maxCachedWorkflows: 1 },
    { maxConcurrentWorkflowTaskExecutions: 1 },
    { maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 3 },
  ])("should refuse capacity combinations the SDK would clamp %j", (capacity) => {
    // GIVEN
    // WHEN
    const result = validateCapacity(capacity, undefined);
    // THEN
    expect(result).toBeErrTagged("ConfigInvalid");
  });

  it("should reject a custom tuner passed past the public types", async ({ serveBroken }) => {
    // GIVEN
    const options = { maxConcurrentActivityTaskExecutions: 2, tuner: {} };
    // WHEN
    const app = await serveBroken(options as never);
    // THEN
    await expect(app.exited).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        issues: [
          {
            path: ["tuner"],
            message: "custom tuners are not supported; use the named capacity options",
          },
        ],
      }),
    );
  });
});
