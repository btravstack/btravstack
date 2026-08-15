import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it } from "vitest";

import { createDeferred } from "./deferred.js";
import type { KernelEvent } from "./events.js";
import { createFakeClock } from "./fake-clock.js";
import { RuntimeStartFailed, type Runtime, type RuntimeHost } from "./runtime.js";
import { start } from "./start.js";
import { runtimeModule } from "./test-fixtures.js";
import { TestRuntimePort, testRuntime } from "./test-runtime.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

describe("start", () => {
  it("builds the graph, serves, and exits cleanly when stopped", async () => {
    const runtime = testRuntime();
    const app = start(runtime.module, { signals: false, probes: false });

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

  it("spends only what is left of preDrainDelayMs when the signal predates serving", async () => {
    // GIVEN a shutdown requested while the graph is still building, and a
    // construction that outlasts the whole pre-drain delay on its own
    const clock = createFakeClock();
    const runtime = testRuntime();
    const built = createDeferred<void>();
    const Slow = Module("Slow")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          make: () => fromSafePromise(built.promise).map(() => ({ text: "hello" })),
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });

    const app = start(Slow, {
      clock,
      signals: false,
      probes: false,
      preDrainDelayMs: 5_000,
      onEvent: () => {},
    });

    app.requestDrain();
    await clock.advance(10_000);

    // WHEN construction finally finishes and the buffered shutdown is observed
    built.resolve(undefined);
    await runtime.untilStarted();

    // THEN the drain does not sit out a further 5s. The delay exists to cover
    // Kubernetes' eventually-consistent endpoint removal after the signal; ten
    // seconds of it have already passed, and paying it again can push the whole
    // shutdown past `terminationGracePeriodSeconds` into a SIGKILL.
    expect(await app.exited).toBeOkWith(
      expect.objectContaining({
        reason: "signal",
        drain: { inFlightAtStart: 0, completed: 0, abandoned: 0 },
      }),
    );
  });

  it("aborts in-flight units when the exit skips the drain", async () => {
    // GIVEN a serving application holding one unit open
    const runtime = testRuntime();
    const app = start(runtime.module, { signals: false, probes: false });
    await runtime.untilStarted();
    const unit = runtime.submit();

    // WHEN it is stopped, which takes the drain-skipping path. The unit is
    // still open as the exit runs — settling it first would leave nothing to
    // abort and the assertion below would pass against any implementation.
    app.stop();
    await app.exited;
    unit.settle(Ok("done"));

    // THEN the unit still got its cancellation cue. Skipping the drain is a
    // decision not to WAIT for work, not a decision to let it run on
    // unsupervised — which is exactly what the uncaught path's own rationale
    // (in-flight work may be completing against corrupted state) demands.
    expect(unit.signal.aborted).toBe(true);
  });

  it("reports a construction failure without wrapping the module's own error", async () => {
    const Failing = Module("Failing")({
      imports: [testRuntime().module],
      provides: [Provider(Greeting)({ make: () => ErrAsync("no-config" as const) })],
      exports: [Greeting, TestRuntimePort],
    });

    const app = start(Failing, { signals: false, probes: false });

    await expect(app.exited).toBeErrWith("no-config");
  });

  it("reports a runtime that refuses to start", async () => {
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };

    const app = start(runtimeModule(broken), { signals: false, probes: false });

    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );
  });

  it("closes the application scope on a clean stop", async () => {
    const released: string[] = [];
    const runtime = testRuntime();
    const Resourceful = Module("Resourceful")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          acquire: () => OkAsync({ text: "hi" }),
          release: () => {
            released.push("greeting");
          },
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });

    const app = start(Resourceful, { signals: false, probes: false });
    await runtime.untilStarted();
    app.stop();
    await app.exited;

    expect(released).toEqual(["greeting"]);
  });

  it("reaches the exited phase when the runtime refuses to start", async () => {
    const events: KernelEvent["type"][] = [];
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };

    const app = start(runtimeModule(broken), {
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
    const runtime = testRuntime();
    const Leaky = Module("Leaky")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          acquire: () => OkAsync({ text: "hi" }),
          release: () => Promise.reject(boom),
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });

    const app = start(Leaky, { signals: false, probes: false, onEvent: () => {} });
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
    const app = start(runtime.module, {
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
    const app = start(runtime.module, { probes: false, preDrainDelayMs: 60_000 });
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

describe("runtimeInfo", () => {
  it("hands back what a serving runtime published about itself", async () => {
    const runtime = testRuntime("greeter");
    const app = start(runtime.module, { signals: false, probes: false });

    await expect(app.runtimeInfo()).toBeOkWith({ name: "greeter" });

    app.stop();
    await app.exited;
  });

  it("resolves undefined for a runtime that publishes nothing", async () => {
    // Publishing is optional: this runtime declares no `Info` at all and omits
    // `Serving.info`, which is the whole point of the default.
    const silent: Runtime<never> = {
      name: "silent",
      needs: [],
      start: () => OkAsync({ drain: () => OkAsync(), stop: () => OkAsync() }),
    };
    const app = start(runtimeModule(silent), { signals: false, probes: false });

    await expect(app.runtimeInfo()).toBeOkWith(undefined);

    app.stop();
    await app.exited;
  });

  it("stays pending until the runtime is serving", async () => {
    const gate = createDeferred<void>();
    const inner = testRuntime();
    const stalled = {
      ...inner,
      start: (host: RuntimeHost<never>) =>
        fromSafePromise(gate.promise).flatMap(() => inner.start(host)),
    };
    const app = start(runtimeModule(stalled), { signals: false, probes: false });

    // Asked for before the runtime is anywhere near serving — the deferred is
    // what lets this be read at any point rather than only after a hook fires.
    const info = app.runtimeInfo();
    let settled = false;
    void info.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(app.phase()).not.toBe("serving");

    gate.resolve(undefined);
    await expect(info).toBeOkWith({ name: "test" });

    app.stop();
    await app.exited;
  });

  it("resolves undefined when the runtime never serves, so a caller cannot hang", async () => {
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "nope" })),
    };
    const app = start(runtimeModule(broken), {
      signals: false,
      probes: false,
      onEvent: () => {},
    });

    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );
    await expect(app.runtimeInfo()).toBeOkWith(undefined);
  });
});
