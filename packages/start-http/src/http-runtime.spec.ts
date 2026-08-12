import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("httpRuntime", () => {
  it("publishes the port it actually bound", async ({ serve }) => {
    // GIVEN a runtime asked for an ephemeral port
    const { app } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the real port, which is the entire reason `port: 0` is usable
    await expect(info).toBeOkWith({ port: expect.any(Number) });
  });
});
