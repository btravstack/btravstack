import { RuntimeStartFailed } from "@btravstack/core";
import { ErrAsync, fromSafePromise } from "unthrown";
import { describe, expect, it as bare } from "vitest";

import { bootFixture } from "./boot-fixture.js";
import { greetingApp, it, runtimeModule } from "./test-fixtures.js";
import { testRuntime } from "./test-runtime.js";

describe("bootFixture", () => {
  it("boots with a test's defaults and stops what it started", async ({ boot }) => {
    // GIVEN an application booted through the fixture, nothing else said
    const { runtime, module } = greetingApp();
    const app = boot(module);
    await runtime.untilStarted();

    // WHEN the fixture's defaults are read back off the running app
    // THEN probes are off and the runtime is serving — the teardown stops it
    // once this test is over, which `exited` settling `Ok` will prove there
    expect({ phase: app.phase(), probes: await app.probePort() }).toEqual({
      phase: "serving",
      probes: expect.objectContaining({ tag: "Ok", value: undefined }),
    });
  });

  it("lets a call bind an ephemeral probe port over the default", async ({ boot }) => {
    // GIVEN a boot asking for a probe server on port 0
    const { runtime, module } = greetingApp();
    const app = boot(module, { probes: { port: 0 } });
    await runtime.untilStarted();

    // WHEN the bound port is read
    // THEN one was bound — the call's option beat the fixture's `false`
    await expect(app.probePort()).toBeOkWith(expect.any(Number));
  });

  bare("fails the test on a shutdown defect, and only on a defect", async () => {
    // GIVEN a runtime whose `stop` blows up
    const runtime = testRuntime();
    const broken = {
      ...runtime,
      start: (host: Parameters<typeof runtime.start>[0]) =>
        runtime.start(host).map((serving) => ({
          ...serving,
          stop: () => fromSafePromise(Promise.reject(new Error("stop blew up"))),
        })),
    };
    const fixture = bootFixture();

    // WHEN the fixture tears down an app that was booted through it
    const run = fixture({}, async (boot) => {
      boot(runtimeModule(broken));
      await runtime.untilStarted();
    });

    // THEN the defect reaches the runner as the throw it is
    await expect(run).rejects.toThrow("stop blew up");
  });

  bare("lets a modeled startup Err pass through the teardown", async () => {
    // GIVEN a runtime that refuses to start with a modeled error
    const runtime = testRuntime();
    const refusing = {
      ...runtime,
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "refusing", cause: "no" })),
    };
    const fixture = bootFixture();

    // WHEN the fixture tears down an app whose exit is that Err
    const run = fixture({}, async (boot) => {
      await expect(boot(runtimeModule(refusing)).exited).toBeErrTagged("RuntimeStartFailed");
    });

    // THEN the test is not failed by the teardown — an Err is an outcome
    await expect(run).resolves.toBeUndefined();
  });

  bare("keeps a boot's own options over the fixture's defaults", async () => {
    // GIVEN defaults with a silent sink and a call that supplies its own
    const seen: string[] = [];
    const runtime = testRuntime();
    const fixture = bootFixture({ onEvent: () => {} });

    // WHEN an app is booted with a listening sink and stopped by the fixture
    await fixture({}, async (boot) => {
      boot(runtimeModule(runtime), { onEvent: (event) => seen.push(event.type) });
      await runtime.untilStarted();
    });

    // THEN the call's sink is the one that heard the lifecycle
    expect(seen).toEqual(["building", "serving", "stopping", "exited"]);
  });
});
