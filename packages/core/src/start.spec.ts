import { Module, Port, Provider } from "@btravstack/di";
import { createFakeClock, testRuntime, TestRuntimePort } from "@btravstack/testing";
import { ErrAsync, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it } from "vitest";

import { runtimeModule } from "./__tests__/test-fixtures.js";
import type { KernelEvent } from "./events.js";
import { RuntimeStartFailed, type Runtime, type RuntimeHost } from "./runtime.js";
import { start } from "./start.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

/** The one event whose absence is as load-bearing as its presence: a clean stop emits none. */
const isStoppedWaiting = (event: KernelEvent): boolean => event.type === "stoppedWaiting";

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
    const built = Promise.withResolvers<void>();
    const Slow = Module("Slow")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          inject: {},
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
      provides: [Provider(Greeting)({ inject: {}, make: () => ErrAsync("no-config" as const) })],
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
          inject: {},
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
    expect(events).toEqual(["building", "startFailed", "stopping", "exited"]);
  });

  it("says on the serving event what the runtime published and what the probe server bound", async () => {
    // GIVEN an application booting with an ephemeral probe port, watching only
    // the `serving` event
    const served: KernelEvent[] = [];
    const runtime = testRuntime();
    const app = start(runtime.module, {
      signals: false,
      probes: { port: 0 },
      onEvent: (event) => {
        if (event.type === "serving") served.push(event);
      },
    });

    // WHEN it reaches serving
    await runtime.untilStarted();
    app.stop();
    await app.exited;

    // THEN the one event names the runtime, what it published, and the port the
    // kernel's own probe listener actually bound — the whole point being that a
    // `PORT=0` boot is otherwise unreadable
    expect(served).toEqual([
      {
        type: "serving",
        runtime: "test",
        info: { name: "test" },
        probePort: expect.any(Number),
      },
    ]);
  });

  it("does not report a shutdown defect as startFailed", async () => {
    // GIVEN a runtime that serves, then defects in `stop()`
    const events: KernelEvent["type"][] = [];
    const runtime = testRuntime();
    const broken = {
      ...runtime,
      start: (host: RuntimeHost<never>) =>
        runtime.start(host).map((serving) => ({
          ...serving,
          stop: () => fromSafePromise(Promise.reject(new Error("stop blew up"))),
        })),
    };
    const app = start(runtimeModule(broken), {
      signals: false,
      probes: false,
      onEvent: (event) => events.push(event.type),
    });
    await runtime.untilStarted();

    // WHEN it is stopped
    app.stop();
    await app.exited;

    // THEN the defect rides `exited`, and the event stream names no startup failure
    expect(events).toEqual(["building", "serving", "stopping", "exited"]);
  });

  it("surfaces a failing release in the exit report's teardown errors", async () => {
    const boom = new Error("release failed");
    const runtime = testRuntime();
    const Leaky = Module("Leaky")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          inject: {},
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

  it("reports a stop whose finalisers outlive stopTimeoutMs, instead of never reporting", async () => {
    // GIVEN a release that never settles — a pool draining to a host that
    // stopped answering — which is the one thing `finish` cannot see, since di
    // closes the scope only after it has returned
    const clock = createFakeClock();
    const runtime = testRuntime();
    const events: KernelEvent[] = [];
    const Wedged = Module("Wedged")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => new Promise<void>(() => {}),
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(Wedged, {
      clock,
      signals: false,
      probes: false,
      stopTimeoutMs: 5_000,
      onEvent: (event) => events.push(event),
    });
    await runtime.untilStarted();
    app.stop();

    // WHEN the stop deadline passes with the finaliser still running
    await clock.advance(5_000);

    // THEN the report exists and says which phase ran long — where before it
    // was never produced at all and the process sat in `stopping` until SIGKILL
    expect({ report: await app.exited, stoppedWaiting: events.filter(isStoppedWaiting) }).toEqual({
      report: expect.toBeOkWith(
        expect.objectContaining({ reason: "runtimeStopped", abandonedAt: "stop" }),
      ),
      stoppedWaiting: [{ type: "stoppedWaiting", phase: "stop", afterMs: 5_000 }],
    });
  });

  it("cuts the stop wait short on a second signal, naming no deadline", async () => {
    // GIVEN a shutdown wedged in its finalisers, with a deadline nobody wants
    // to wait out
    const runtime = testRuntime();
    const events: KernelEvent[] = [];
    const Wedged = Module("WedgedBySignal")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => new Promise<void>(() => {}),
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(Wedged, {
      probes: false,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      stopTimeoutMs: 600_000,
      onEvent: (event) => events.push(event),
    });
    await runtime.untilStarted();

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.emit("SIGTERM");

    // WHEN the operator asks a second time
    // THEN the wait ends now and `afterMs` is absent, because the ten-minute
    // deadline is not what ended it
    expect({ report: await app.exited, stoppedWaiting: events.filter(isStoppedWaiting) }).toEqual({
      report: expect.toBeOkWith(expect.objectContaining({ reason: "signal", abandonedAt: "stop" })),
      stoppedWaiting: [{ type: "stoppedWaiting", phase: "stop", afterMs: undefined }],
    });
  });

  it("reports an uncaught exception raised while the graph is still building", async () => {
    // GIVEN a provider that never resolves, so the application never serves —
    // and an uncaught exception, whose handler has already suppressed Node's
    // own exit code by being installed at all
    const uncaughtListeners = (): number =>
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
    const before = uncaughtListeners();
    const runtime = testRuntime();
    const events: KernelEvent[] = [];
    const NeverBuilds = Module("NeverBuilds")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({ inject: {}, make: () => fromSafePromise(new Promise(() => {})) }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(NeverBuilds, {
      probes: false,
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeCrash = app.phase();

    // WHEN it crashes mid-build
    process.emit("uncaughtException", new Error("boom"));

    // THEN the crash is reported rather than absorbed: `70` under `runMain`,
    // through `stopping` like every other route out of a half-built graph, with
    // `runtimeInfo()` settled rather than left hanging on a runtime that never
    // served, and the handlers gone so the next test's signals are its own
    expect({
      beforeCrash,
      report: await app.exited,
      info: await app.runtimeInfo(),
      phases: events.map((event) => event.type),
      listeners: uncaughtListeners() - before,
    }).toEqual({
      beforeCrash: "building",
      report: expect.toBeOkWith(
        expect.objectContaining({ reason: "uncaught", drain: undefined, abandonedAt: "build" }),
      ),
      info: expect.toBeOkWith(undefined),
      phases: ["building", "uncaught", "stoppedWaiting", "stopping", "exited"],
      listeners: 0,
    });
  });

  it("gives up on a build a second signal has given up on", async () => {
    // GIVEN a boot that hangs — an unreachable dependency acquired at
    // construction — where the FIRST signal is deliberately buffered for the
    // drain that a serving application would run
    const runtime = testRuntime();
    const NeverBuilds = Module("NeverBuildsSignal")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({ inject: {}, make: () => fromSafePromise(new Promise(() => {})) }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(NeverBuilds, { probes: false, onEvent: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterFirstSignal = app.phase();

    // WHEN the operator asks again
    process.emit("SIGTERM");

    // THEN the first was buffered — nothing observes it until the runtime
    // serves, which this graph never does — and the second is what makes the
    // kernel stop waiting for a build that was never going to finish
    expect({ afterFirstSignal, report: await app.exited }).toEqual({
      afterFirstSignal: "building",
      report: expect.toBeOkWith(
        expect.objectContaining({ reason: "signal", abandonedAt: "build" }),
      ),
    });
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
      resolves: [],
      start: () => OkAsync({ drain: () => OkAsync(), stop: () => OkAsync() }),
    };
    const app = start(runtimeModule(silent), { signals: false, probes: false });

    await expect(app.runtimeInfo()).toBeOkWith(undefined);

    app.stop();
    await app.exited;
  });

  it("stays pending until the runtime is serving", async () => {
    const gate = Promise.withResolvers<void>();
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
