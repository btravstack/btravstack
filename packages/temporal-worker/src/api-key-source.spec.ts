import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("renewable worker credentials", () => {
  it("keeps serving after the application's credential rotates", async ({
    secured,
    renewable,
    serveRenewable,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    const { client, taskQueue, taken } = await serveRenewable(renewable.source, env);
    renewable.set("temporal-test-second");
    await vi.waitUntil(() => taken().some(({ name }) => name === "reload"));

    // WHEN
    const answer = await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `renewable-${taskQueue}`,
      args: ["renewed"],
    });

    // THEN
    expect({ answer, reloads: taken().filter(({ name }) => name === "reload") }).toEqual({
      answer: "renewed",
      reloads: [{ component: "temporal", name: "reload", attributes: {}, outcome: "ok" }],
    });
  });

  it("refuses startup when its credential source is unavailable", async ({
    secured,
    renewable,
    serveRenewable,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    renewable.set(undefined);

    // WHEN
    const { app } = await serveRenewable(renewable.source, env);

    // THEN
    await expect(app.exited).toBeErrTagged("TemporalApiKeyUnavailable");
  });

  it("withdraws readiness before in-flight work finishes on credential removal", async ({
    secured,
    renewable,
    serveRenewable,
    gate,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    const { app, client, taskQueue, taken } = await serveRenewable(
      renewable.source,
      env,
      gate.activities,
    );
    await client.workflow.start("runEcho", {
      taskQueue,
      workflowId: `removed-${taskQueue}`,
      args: ["held"],
    });
    await gate.arrived;
    const readyBefore = app.ready();
    let exited = false;
    void app.exited.then(() => {
      exited = true;
    });
    let exitedBeforeRelease: boolean;

    // WHEN
    renewable.set(undefined);
    try {
      await vi.waitUntil(() => !app.ready());
      exitedBeforeRelease = exited;
    } finally {
      gate.release();
    }
    const report = (await app.exited).getOrThrow();

    // THEN
    expect({
      readyBefore,
      readyAfter: app.ready(),
      exitedBeforeRelease,
      reason: report.reason,
      unexpectedRuntimeStop: report.unexpectedRuntimeStop,
      reloads: taken().filter(({ name }) => name === "reload"),
    }).toEqual({
      readyBefore: true,
      readyAfter: false,
      exitedBeforeRelease: false,
      reason: "runtimeStopped",
      unexpectedRuntimeStop: true,
      reloads: [{ component: "temporal", name: "reload", attributes: {}, outcome: "error" }],
    });
  });
});
