import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import type { KernelEvent } from "./events.js";
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

    let settledEarly = false;
    void app.exited.then(() => {
      settledEarly = true;
    });

    await runtime.untilStarted();
    expect(runtime.started()).toBe(true);

    // A full macrotask turn after the runtime is serving: `exited` must still
    // be pending, or this test would also pass against an implementation that
    // ignores `stop()` and settles the moment the runtime is up.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledEarly).toBe(false);
    expect(app.phase()).toBe("serving");

    app.stop();

    const report = await app.exited;
    expect(report).toBeOkWith(
      expect.objectContaining({ reason: "runtimeStopped", teardownErrors: [] }),
    );
    expect(app.phase()).toBe("exited");
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

  it("reaches the exited phase when the runtime refuses to start", async () => {
    const events: KernelEvent["type"][] = [];
    const broken = {
      ...testRuntime(),
      start: () =>
        Err(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })).toAsync(),
    };

    const app = start(AppModule, {
      runtime: broken,
      signals: false,
      probes: false,
      onEvent: (event) => events.push(event.type),
    });

    await app.exited;

    expect(app.phase()).toBe("exited");
    expect(events).toEqual(["building", "stopping", "exited"]);
  });

  it("surfaces a failing release in the exit report's teardown errors", async () => {
    const boom = new Error("release failed");
    const Leaky = Module("Leaky")({
      provides: [
        Provider(Greeting)({
          acquire: () => Ok({ text: "hi" }).toAsync(),
          release: () => Promise.reject(boom),
        }),
      ],
      exports: [Greeting],
    });

    const runtime = testRuntime();
    const app = start(Leaky, { runtime, signals: false, probes: false, onEvent: () => {} });
    await runtime.untilStarted();
    app.stop();

    // The report is built before di closes the scope, so this only holds
    // because `ExitReport.teardownErrors` aliases the live array.
    expect(await app.exited).toBeOkWith(
      expect.objectContaining({
        teardownErrors: [{ port: "Greeting", cause: boom }],
      }),
    );
  });

  it("drains on SIGTERM and skips the drain on a second signal", async () => {
    const listenerCount = (): number =>
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    const before = listenerCount();

    const runtime = testRuntime();
    const app = start(AppModule, {
      runtime,
      probes: false,
      preDrainDelayMs: 60_000,
      drainTimeoutMs: 60_000,
    });
    await runtime.untilStarted();
    expect(listenerCount()).toBe(before + 2);

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.phase()).toBe("draining");

    process.emit("SIGTERM");

    const report = await app.exited;
    expect(report).toBeOkWith(expect.objectContaining({ reason: "signal" }));
    // Load-bearing: a leaked listener from this app would fire into (and
    // throw off) every subsequent test in this file that emits a signal.
    expect(listenerCount()).toBe(before);
  });

  it("skips the drain and marks itself unready on an uncaught exception", async () => {
    const uncaughtListenerCount = (): number =>
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
    const before = uncaughtListenerCount();

    const runtime = testRuntime();
    const app = start(AppModule, { runtime, probes: false, preDrainDelayMs: 60_000 });
    await runtime.untilStarted();
    expect(uncaughtListenerCount()).toBe(before + 2);

    process.emit("uncaughtException", new Error("boom"));

    const report = await app.exited;
    expect(report).toBeOkWith(expect.objectContaining({ reason: "uncaught", drain: undefined }));
    // Load-bearing for the same reason as the signal test above: a leaked
    // listener here would fire into every subsequent test in this file that
    // emits an uncaught exception or rejection.
    expect(uncaughtListenerCount()).toBe(before);
  });
});
