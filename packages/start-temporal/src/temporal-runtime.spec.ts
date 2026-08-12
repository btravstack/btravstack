import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("temporalRuntime", () => {
  it("publishes the task queue and namespace it polls", async ({ serve }) => {
    // GIVEN a worker polling a queue of this test's own
    const { app, taskQueue } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the pair that identifies a Temporal worker to an operator
    await expect(info).toBeOkWith({ taskQueue, namespace: "default" });
  });
});
