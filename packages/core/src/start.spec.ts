import { Module, Port, Provider } from "@btravstack/di";
import { createFakeClock, testRuntime, TestRuntimePort } from "@btravstack/testing";
import { ErrAsync, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { runtimeModule } from "./__tests__/test-fixtures.js";
import type { KernelEvent } from "./events.js";
import { RuntimeStartFailed, type Runtime, type RuntimeHost } from "./runtime.js";
import { start } from "./start.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

/** The one event whose absence is as load-bearing as its presence: a clean stop emits none. */
const isStoppedWaiting = (event: KernelEvent): boolean => event.type === "stoppedWaiting";

describe("start", () => {
  it("builds the graph, serves, and exits cleanly when stopped", async () => {
    // GIVEN
    const runtime = testRuntime();
    const app = start(runtime.module, { signals: false, probes: false });

    let settledEarly = false;
    void app.exited.then(() => {
      settledEarly = true;
    });

    // WHEN it reaches serving
    await runtime.untilStarted();
    // THEN it is serving and exited is still pending
    expect(runtime.started()).toBe(true);

    // A full macrotask turn after the runtime is serving: `exited` must still
    // be pending, or this test would also pass against an implementation that
    // ignores `stop()` and settles the moment the runtime is up.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledEarly).toBe(false);
    expect(app.phase()).toBe("serving");

    // WHEN it is stopped
    app.stop();

    // THEN
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
    // GIVEN
    const Failing = Module("Failing")({
      imports: [testRuntime().module],
      provides: [Provider(Greeting)({ inject: {}, make: () => ErrAsync("no-config" as const) })],
      exports: [Greeting, TestRuntimePort],
    });

    // WHEN
    const app = start(Failing, { signals: false, probes: false });

    // THEN
    await expect(app.exited).toBeErrWith("no-config");
  });

  it("reports a runtime that refuses to start", async () => {
    // GIVEN
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };

    // WHEN
    const app = start(runtimeModule(broken), { signals: false, probes: false });

    // THEN
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );
  });

  it("closes the application scope on a clean stop", async () => {
    // GIVEN
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

    // WHEN
    const app = start(Resourceful, { signals: false, probes: false });
    await runtime.untilStarted();
    app.stop();
    await app.exited;

    // THEN
    expect(released).toEqual(["greeting"]);
  });

  it("reaches the exited phase when the runtime refuses to start", async () => {
    // GIVEN
    const events: KernelEvent["type"][] = [];
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };

    // WHEN
    const app = start(runtimeModule(broken), {
      signals: false,
      probes: false,
      onEvent: (event) => events.push(event.type),
    });

    await app.exited;

    // THEN
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
      probes: { port: 0, host: "127.0.0.1" },
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
    // GIVEN
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

    // WHEN
    const app = start(Leaky, { signals: false, probes: false, onEvent: () => {} });
    await runtime.untilStarted();
    app.stop();

    // THEN
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

  it("keeps its signal handlers and the stopping phase while a finaliser is still running", async () => {
    // GIVEN a serving application whose one release announces that it has
    // begun and then never settles
    const listenerCount = (): number =>
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    const before = listenerCount();
    const releasing = Promise.withResolvers<void>();
    const runtime = testRuntime();
    const events: KernelEvent[] = [];
    const Wedged = Module("WedgedAfterStop")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => {
            releasing.resolve();
            return new Promise<void>(() => {});
          },
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(Wedged, {
      clock: createFakeClock(),
      probes: false,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      stopTimeoutMs: 600_000,
      onEvent: (event) => events.push(event),
    });
    await runtime.untilStarted();
    process.emit("SIGTERM");
    await releasing.promise;
    const duringRelease = { phase: app.phase(), listeners: listenerCount() - before };

    // WHEN a second signal lands while the release is blocked
    process.emit("SIGTERM");

    // THEN the lifecycle was still listening, and the second signal takes the
    // abandoned-stop path at once rather than waiting out the deadline
    expect({
      duringRelease,
      report: await app.exited,
      stoppedWaiting: events.filter(isStoppedWaiting),
      listeners: listenerCount() - before,
    }).toEqual({
      duringRelease: { phase: "stopping", listeners: 2 },
      report: expect.toBeOkWith(expect.objectContaining({ reason: "signal", abandonedAt: "stop" })),
      stoppedWaiting: [{ type: "stoppedWaiting", phase: "stop", afterMs: undefined }],
      listeners: 0,
    });
  });

  it("bounds the cleanup of a runtime that refused to start by stopTimeoutMs", async () => {
    // GIVEN a runtime that refuses to start over a graph whose release
    // announces that it has begun and then never settles
    const clock = createFakeClock();
    const releasing = Promise.withResolvers<void>();
    const events: KernelEvent[] = [];
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };
    const Wedged = Module("WedgedAfterStartFailed")({
      imports: [runtimeModule(broken)],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => {
            releasing.resolve();
            return new Promise<void>(() => {});
          },
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
    await releasing.promise;

    // WHEN the stop deadline passes with the release still running
    await clock.advance(5_000);

    // THEN the startup failure is still what `exited` reports, and the
    // abandoned cleanup is named beside it
    expect({
      exited: await app.exited,
      phase: app.phase(),
      events: events.map((event) => event.type),
      stoppedWaiting: events.filter(isStoppedWaiting),
    }).toEqual({
      exited: expect.toBeErrTagged(
        "RuntimeStartFailed",
        expect.objectContaining({ runtime: "broken" }),
      ),
      phase: "exited",
      events: ["building", "startFailed", "stopping", "stoppedWaiting", "exited"],
      stoppedWaiting: [{ type: "stoppedWaiting", phase: "stop", afterMs: 5_000 }],
    });
  });

  it("releases the graph of a runtime that refused to start, naming no deadline", async () => {
    // GIVEN a runtime that refuses to start over a graph whose release settles
    const released: string[] = [];
    const events: KernelEvent["type"][] = [];
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };
    const Resourceful = Module("ResourcefulAfterStartFailed")({
      imports: [runtimeModule(broken)],
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

    // WHEN it boots
    const app = start(Resourceful, {
      clock: createFakeClock(),
      signals: false,
      probes: false,
      onEvent: (event) => events.push(event.type),
    });

    // THEN
    expect({ exited: await app.exited, released, events }).toEqual({
      exited: expect.toBeErrTagged(
        "RuntimeStartFailed",
        expect.objectContaining({ runtime: "broken" }),
      ),
      released: ["greeting"],
      events: ["building", "startFailed", "stopping", "exited"],
    });
  });

  it("emits nothing once exited, when a release it stopped waiting for fails late", async () => {
    // GIVEN a runtime that refused to start, and a release the deadline gave
    // up on that then rejects — which di reports, and which `Module.scoped`
    // settling would otherwise report as a startup failure a second time
    const clock = createFakeClock();
    const releasing = Promise.withResolvers<void>();
    const releaseFails = Promise.withResolvers<void>();
    const events: KernelEvent["type"][] = [];
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })),
    };
    const Wedged = Module("FailsLateAfterStartFailed")({
      imports: [runtimeModule(broken)],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => {
            releasing.resolve();
            return releaseFails.promise;
          },
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(Wedged, {
      clock,
      signals: false,
      probes: false,
      stopTimeoutMs: 5_000,
      onEvent: (event) => events.push(event.type),
    });
    await releasing.promise;
    await clock.advance(5_000);
    await app.exited;

    // WHEN the abandoned release finally fails
    releaseFails.reject(new Error("release failed late"));
    await clock.advance(0);

    // THEN `exited` is still the last thing the lifecycle said
    expect(events).toEqual(["building", "startFailed", "stopping", "stoppedWaiting", "exited"]);
  });

  it("keeps a teardown failure that lands after the report on the report, not the event stream", async () => {
    // GIVEN a stop the deadline gave up on, whose release then rejects
    const clock = createFakeClock();
    const releasing = Promise.withResolvers<void>();
    const releaseFails = Promise.withResolvers<void>();
    const boom = new Error("release failed late");
    const runtime = testRuntime();
    const events: KernelEvent["type"][] = [];
    const Wedged = Module("FailsLateAfterStop")({
      imports: [runtime.module],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => {
            releasing.resolve();
            return releaseFails.promise;
          },
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(Wedged, {
      clock,
      signals: false,
      probes: false,
      stopTimeoutMs: 5_000,
      onEvent: (event) => events.push(event.type),
    });
    await runtime.untilStarted();
    app.stop();
    await releasing.promise;
    await clock.advance(5_000);
    const report = (await app.exited).getOrThrow();

    // WHEN the abandoned release finally fails
    releaseFails.reject(boom);
    await vi.waitUntil(() => report.teardownErrors.length > 0);

    // THEN the report's live array has it, and the stream still ends at `exited`
    expect({ teardownErrors: report.teardownErrors, last: events.at(-1) }).toEqual({
      teardownErrors: [{ port: "Greeting", cause: boom }],
      last: "exited",
    });
  });

  it("bounds the cleanup of a runtime whose start throws instead of answering", async () => {
    // GIVEN a runtime whose `start` throws synchronously, so no `AsyncResult`
    // exists to tap, over a graph whose release never settles
    const clock = createFakeClock();
    const releasing = Promise.withResolvers<void>();
    const boom = new Error("start threw");
    const events: KernelEvent["type"][] = [];
    const throwing = {
      ...testRuntime(),
      start: () => {
        // oxlint-disable-next-line unthrown/no-throw -- the synchronous throw is the subject under test
        throw boom;
      },
    };
    const Wedged = Module("WedgedAfterStartThrew")({
      imports: [runtimeModule(throwing)],
      provides: [
        Provider(Greeting)({
          inject: {},
          acquire: () => OkAsync({ text: "hi" }),
          release: () => {
            releasing.resolve();
            return new Promise<void>(() => {});
          },
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });
    const app = start(Wedged, {
      clock,
      signals: false,
      probes: false,
      stopTimeoutMs: 5_000,
      onEvent: (event) => events.push(event.type),
    });
    await releasing.promise;

    // WHEN the stop deadline passes with the release still running
    await clock.advance(5_000);

    // THEN the throw is reported as the defect it is, after the abandoned cleanup
    expect({ exited: await app.exited, events }).toEqual({
      exited: expect.toBeDefectWith(boom),
      events: ["building", "startFailed", "stopping", "stoppedWaiting", "exited"],
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
    // GIVEN
    const listenerCount = (): number =>
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    const before = listenerCount();

    const runtime = testRuntime();
    const app = start(runtime.module, {
      probes: false,
      preDrainDelayMs: 60_000,
      drainTimeoutMs: 60_000,
    });
    // WHEN it reaches serving
    await runtime.untilStarted();
    // THEN its signal listeners are installed
    expect(listenerCount()).toBe(before + 2);

    // WHEN a first SIGTERM lands
    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // THEN it drains
    expect(app.phase()).toBe("draining");

    // WHEN a second one lands
    process.emit("SIGTERM");

    // THEN it exits without waiting out the drain, and removes its listeners
    const report = await app.exited;
    expect(report).toBeOkWith(expect.objectContaining({ reason: "signal" }));
    // Load-bearing: a leaked listener from this app would fire into (and
    // throw off) every subsequent test in this file that emits a signal.
    expect(listenerCount()).toBe(before);
  });

  it("skips the drain and marks itself unready on an uncaught exception", async () => {
    // GIVEN
    const uncaughtListenerCount = (): number =>
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
    const before = uncaughtListenerCount();

    const runtime = testRuntime();
    const app = start(runtime.module, { probes: false, preDrainDelayMs: 60_000 });
    // WHEN it reaches serving
    await runtime.untilStarted();
    // THEN its uncaught handlers are installed
    expect(uncaughtListenerCount()).toBe(before + 2);

    // WHEN an uncaught exception lands
    process.emit("uncaughtException", new Error("boom"));

    // THEN it skips the drain, and removes its handlers
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
    // GIVEN
    const runtime = testRuntime("greeter");
    const app = start(runtime.module, { signals: false, probes: false });

    // WHEN its runtime info is asked for
    // THEN
    await expect(app.runtimeInfo()).toBeOkWith({ name: "greeter" });

    app.stop();
    await app.exited;
  });

  it("resolves undefined for a runtime that publishes nothing", async () => {
    // GIVEN
    // Publishing is optional: this runtime declares no `Info` at all and omits
    // `Serving.info`, which is the whole point of the default.
    const silent: Runtime<never> = {
      name: "silent",
      resolves: [],
      start: () => OkAsync({ drain: () => OkAsync(), stop: () => OkAsync() }),
    };
    const app = start(runtimeModule(silent), { signals: false, probes: false });

    // WHEN its runtime info is asked for
    // THEN
    await expect(app.runtimeInfo()).toBeOkWith(undefined);

    app.stop();
    await app.exited;
  });

  it("stays pending until the runtime is serving", async () => {
    // GIVEN
    const gate = Promise.withResolvers<void>();
    const inner = testRuntime();
    const stalled = {
      ...inner,
      start: (host: RuntimeHost<never>) =>
        fromSafePromise(gate.promise).flatMap(() => inner.start(host)),
    };
    const app = start(runtimeModule(stalled), { signals: false, probes: false });

    // WHEN its runtime info is asked for before the runtime serves
    // Asked for before the runtime is anywhere near serving — the deferred is
    // what lets this be read at any point rather than only after a hook fires.
    const info = app.runtimeInfo();
    let settled = false;
    void info.then(() => {
      settled = true;
    });

    // THEN it stays pending
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(app.phase()).not.toBe("serving");

    // WHEN the runtime starts serving
    gate.resolve(undefined);
    // THEN it resolves
    await expect(info).toBeOkWith({ name: "test" });

    app.stop();
    await app.exited;
  });

  it("resolves undefined when the runtime never serves, so a caller cannot hang", async () => {
    // GIVEN
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "nope" })),
    };
    // WHEN
    const app = start(runtimeModule(broken), {
      signals: false,
      probes: false,
      onEvent: () => {},
    });

    // THEN
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );
    await expect(app.runtimeInfo()).toBeOkWith(undefined);
  });

  it("stops the application when the runtime says it has stopped serving", async () => {
    // GIVEN a runtime that gives up on its own — a worker whose poll loop died,
    // a consumer the server cancelled — with nobody asking it to
    const gave = Promise.withResolvers<void>();
    const selfStopping: Runtime<never, { readonly name: string }> = {
      name: "selfStopping",
      resolves: [],
      start: () =>
        OkAsync({
          info: { name: "selfStopping" },
          drain: () => OkAsync(),
          stop: () => OkAsync(),
          stopped: () => fromSafePromise(gave.promise),
        }),
    };
    const app = start(runtimeModule(selfStopping), {
      signals: false,
      probes: false,
      onEvent: () => {},
    });
    // Setup synchronisation, not an assertion: the test's one `expect` is on
    // `exited` below.
    (await app.runtimeInfo()).get();

    // WHEN it reports that it has stopped
    gave.resolve();

    // THEN the process stops, reporting the same reason a `stop()` call does —
    // and the drain is skipped, because nothing asked for one. Without this
    // channel the lifecycle only ever moved on a signal or a caller, so the
    // process stayed alive with `/readyz` answering 200: a pod in a Service's
    // endpoints, serving nothing.
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ reason: "runtimeStopped", drain: undefined }),
    );
  });

  it("withdraws the stopped channel when the kernel is the one that asked", async () => {
    // GIVEN a runtime whose `stopped` channel is wired the way a real one is:
    // it settles when the transport ends, and withdraws when the end was the
    // kernel's own doing
    let asked = false;
    let channelObserved = false;
    let channelSettled = false;
    const ended = Promise.withResolvers<void>();
    const wired: Runtime<never, { readonly name: string }> = {
      name: "wired",
      resolves: [],
      start: () =>
        OkAsync({
          info: { name: "wired" },
          drain: () => {
            asked = true;
            ended.resolve();
            return OkAsync();
          },
          stop: () => {
            asked = true;
            ended.resolve();
            return OkAsync();
          },
          stopped: () => {
            channelObserved = true;
            return fromSafePromise(ended.promise)
              .flatMap(() => (asked ? fromSafePromise(new Promise<void>(() => {})) : OkAsync()))
              .tap(() => {
                channelSettled = true;
              });
          },
        }),
    };
    const app = start(runtimeModule(wired), {
      signals: false,
      probes: false,
      onEvent: () => {},
    });
    (await app.runtimeInfo()).get();

    // WHEN a caller stops it
    app.stop();
    const report = await app.exited;

    // THEN the kernel SUBSCRIBED and the channel never settled. Both halves
    // are needed and neither is the reason: `RunningApp.stop()` reports
    // `runtimeStopped` whatever the channel does, and a kernel that stopped
    // calling `stopped()` at all would leave `channelSettled` false too — so
    // `channelObserved` is what stops this passing on a deleted subscription,
    // and `channelSettled` is the withdrawal obligation itself.
    expect({ reason: report.getOrThrow().reason, channelObserved, channelSettled }).toEqual({
      reason: "runtimeStopped",
      channelObserved: true,
      channelSettled: false,
    });
  });
});
