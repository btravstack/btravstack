import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import { RuntimeStartFailed } from "./runtime.js";
import { start } from "./start.js";
import { testRuntime } from "./test-runtime.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

describe("start", () => {
  it("builds the graph, serves, and exits cleanly when stopped", async () => {
    const runtime = testRuntime();
    const app = start(AppModule, { runtime, signals: false, probes: false });

    await runtime.untilStarted();
    expect(runtime.started()).toBe(true);

    app.stop();

    const report = await app.exited;
    expect(report).toBeOkWith(
      expect.objectContaining({ reason: "runtimeStopped", teardownErrors: [] }),
    );
  });

  it("reports a construction failure without wrapping the module's own error", async () => {
    const Failing = Module("Failing")({
      provides: [Provider(Greeting)({ make: () => Err("no-config" as const).toAsync() })],
      exports: [Greeting],
    });

    const app = start(Failing, { runtime: testRuntime(), signals: false, probes: false });

    await expect(app.exited).toBeErrWith("no-config");
  });

  it("reports a runtime that refuses to start", async () => {
    const broken = {
      ...testRuntime(),
      start: () =>
        Err(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })).toAsync(),
    };

    const app = start(AppModule, { runtime: broken, signals: false, probes: false });

    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );
  });

  it("closes the application scope on a clean stop", async () => {
    const released: string[] = [];
    const Resourceful = Module("Resourceful")({
      provides: [
        Provider(Greeting)({
          acquire: () => Ok({ text: "hi" }).toAsync(),
          release: () => {
            released.push("greeting");
          },
        }),
      ],
      exports: [Greeting],
    });

    const runtime = testRuntime();
    const app = start(Resourceful, { runtime, signals: false, probes: false });
    await runtime.untilStarted();
    app.stop();
    await app.exited;

    expect(released).toEqual(["greeting"]);
  });
});
