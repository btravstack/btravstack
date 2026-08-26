import { createServer } from "node:net";

import { Module, Port, Provider } from "@btravstack/di";
import { createFakeClock, testRuntime, TestRuntimePort } from "@btravstack/testing";
import { ErrAsync, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it, runtimeModule } from "./__tests__/test-fixtures.js";
import { RuntimeStartFailed, type RuntimeHost } from "./runtime.js";
import { start, type RunningApp } from "./start.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
};

const boundPort = async (app: RunningApp<never, unknown>): Promise<number> => {
  const port = (await app.probePort()).get();
  if (port === undefined) {
    // oxlint-disable-next-line unthrown/no-throw -- a test-only fixture: reaching here means the probe server never bound, which is a bug in the test rather than a modeled outcome
    throw new Error("[invariants] the probe server did not bind");
  }
  return port;
};

// Holds a port so the probe server cannot have it — the only way to provoke a
// bind failure at a port we know the value of.
const occupy = (
  port: number,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
    server.unref();
  });

type HandlerCounts = {
  readonly SIGTERM: number;
  readonly SIGINT: number;
  readonly uncaughtException: number;
  readonly unhandledRejection: number;
};

const handlerCounts = (): HandlerCounts => ({
  SIGTERM: process.listenerCount("SIGTERM"),
  SIGINT: process.listenerCount("SIGINT"),
  uncaughtException: process.listenerCount("uncaughtException"),
  unhandledRejection: process.listenerCount("unhandledRejection"),
});

// Every one of `start`'s four process handlers, one higher.
const allRaisedFrom = (base: HandlerCounts): HandlerCounts => ({
  SIGTERM: base.SIGTERM + 1,
  SIGINT: base.SIGINT + 1,
  uncaughtException: base.uncaughtException + 1,
  unhandledRejection: base.unhandledRejection + 1,
});

describe("load-bearing invariants", () => {
  // 1. Readiness goes false before the runtime stops accepting — asserted below
  //    in "the drain flips readiness false before the runtime stops accepting",
  //    and inside `drainApp` by `drain.spec.ts`.

  it("2. in-flight units complete when the drain has time for them", async ({ boot }) => {
    const clock = createFakeClock();
    const runtime = testRuntime();

    const app = boot(runtime.module, { clock, preDrainDelayMs: 5_000 });
    await runtime.untilStarted();
    const unit = runtime.submit<string>();

    app.requestDrain();
    await clock.advance(5_000);

    unit.settle(Ok("done"));
    await unit.result;

    const report = await app.exited;

    // `drain.spec.ts` proves the accounting inside `drainApp`; what this adds is
    // the wiring — a unit submitted through `RunUnit` lands in the registry the
    // drain counts, and the count reaches `ExitReport.drain`.
    expect(report).toBeOkWith(
      expect.objectContaining({
        reason: "signal",
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });

  it("3. units still open at the deadline are counted as abandoned", async ({ boot }) => {
    const clock = createFakeClock();
    const runtime = testRuntime();

    const app = boot(runtime.module, { clock, preDrainDelayMs: 5_000 });
    await runtime.untilStarted();
    runtime.submit<string>();

    app.requestDrain();
    await clock.advance(5_000);
    await clock.advance(20_000);

    const report = await app.exited;

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
  });

  it("4. the unit AbortSignal fires at the drain deadline", async ({ boot }) => {
    const clock = createFakeClock();
    const runtime = testRuntime();
    let aborted = false;

    const app = boot(runtime.module, { clock, preDrainDelayMs: 5_000 });
    await runtime.untilStarted();
    const unit = runtime.submit<string>();
    unit.signal.addEventListener("abort", () => {
      aborted = true;
    });

    app.requestDrain();
    await clock.advance(5_000);
    const afterPreDrain = aborted;

    await clock.advance(20_000);
    await app.exited;

    // The abort comes from `registry.abortAll()` at the deadline, not from the
    // runtime honouring `Serving.drain(signal)` — `testRuntime` ignores that
    // signal, which is what makes this a test of the kernel.
    expect({ afterPreDrain, afterDeadline: aborted }).toEqual({
      afterPreDrain: false,
      afterDeadline: true,
    });
  });

  it("5. the application scope closes on a startup failure", async () => {
    const released: string[] = [];
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "nope" })),
    };
    const Half = Module("Half")({
      imports: [runtimeModule(broken)],
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

    const app = start(Half, {
      signals: false,
      probes: false,
      onEvent: () => {},
    });
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );

    // `start.spec.ts` covers the happy path; this is the other one — a failure
    // short-circuits past `finish`, and the scope still closes.
    expect(released).toEqual(["greeting"]);
  });

  // 6. A second signal skips the drain — covered by `start.spec.ts`'s "drains on
  //    SIGTERM and skips the drain on a second signal", against real handlers.

  it("7. teardown errors are collected without masking the exit reason", async () => {
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

    const clock = createFakeClock();
    const app = start(Leaky, {
      clock,
      signals: false,
      probes: false,
      onEvent: () => {},
    });

    await runtime.untilStarted();
    app.requestDrain();
    await clock.advance(5_000);

    // `start.spec.ts` proves they are collected; what this adds is the other
    // half — a failing finaliser does not turn the exit into a failure, nor
    // rewrite the reason the application stopped.
    expect(await app.exited).toBeOkWith(
      expect.objectContaining({
        reason: "signal",
        drain: { inFlightAtStart: 0, completed: 0, abandoned: 0 },
        teardownErrors: [{ port: "Greeting", cause: boom }],
      }),
    );
  });

  it("8. start neither throws nor calls process.exit", async ({ boot }) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const runtime = testRuntime();

    const app = boot(runtime.module);
    await runtime.untilStarted();
    // `untilStarted` resolves from inside `Runtime.start`, before the kernel's
    // own continuation advances the tracker — so the live phase here is
    // `"starting"` or `"serving"`, never a terminal one.
    expect(app.phase()).not.toBe("exited");
    expect(runtime.started()).toBe(true);

    app.stop();
    await app.exited;

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // 9. Signal listeners are removed on exit — covered twice in `start.spec.ts`,
  //    once per handler family. The bind-failure route is the one they do not
  //    reach, and is asserted below.
});

describe("probe wiring", () => {
  it("readiness is false while the graph is still building", async () => {
    const gate = Promise.withResolvers<void>();
    const inner = testRuntime();
    const stalled = {
      ...inner,
      start: (host: RuntimeHost<never>) =>
        fromSafePromise(gate.promise).flatMap(() => inner.start(host)),
    };

    const app = start(runtimeModule(stalled), {
      signals: false,
      probes: { port: 0 },
      onEvent: () => {},
    });

    const port = await boundPort(app);
    expect(app.phase()).not.toBe("serving");
    expect(await get(port, "/readyz")).toEqual({ status: 503, body: "unavailable" });

    gate.resolve(undefined);
    await inner.untilStarted();
    app.stop();
    await app.exited;
  });

  it("liveness is true from building onward", async () => {
    const gate = Promise.withResolvers<void>();
    const inner = testRuntime();
    const stalled = {
      ...inner,
      start: (host: RuntimeHost<never>) =>
        fromSafePromise(gate.promise).flatMap(() => inner.start(host)),
    };

    const app = start(runtimeModule(stalled), {
      signals: false,
      probes: { port: 0 },
      onEvent: () => {},
    });

    const port = await boundPort(app);
    expect(app.phase()).not.toBe("serving");
    expect(await get(port, "/livez")).toEqual({ status: 200, body: "ok" });

    gate.resolve(undefined);
    await inner.untilStarted();
    app.stop();
    await app.exited;
  });

  it("the drain flips readiness false before the runtime stops accepting", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();
    const app = start(runtime.module, {
      clock,
      signals: false,
      probes: { port: 0 },
      onEvent: () => {},
    });

    await runtime.untilStarted();
    const port = await boundPort(app);
    expect(await get(port, "/readyz")).toEqual({ status: 200, body: "ready" });

    app.requestDrain();

    // A `fetch` is a macrotask, so the drain's first beat has run by the time
    // this lands, while its pre-drain delay is still pending on the fake clock:
    // readiness goes false strictly first, which is the point of the delay.
    //
    // This test does NOT guard the `forcedUnready` latch — on this path the
    // phase term alone already answers false — it guards the ORDERING, and
    // fails if the pre-drain delay is removed.
    expect((await get(port, "/readyz")).status).toBe(503);
    expect(runtime.accepting()).toBe(true);

    await clock.advance(5_000);
    expect(runtime.accepting()).toBe(false);

    await app.exited;
  });

  it("an uncaught exception forces readiness false while the phase is still serving", async () => {
    const stopGate = Promise.withResolvers<void>();
    const inner = testRuntime();
    const held = {
      ...inner,
      start: (host: RuntimeHost<never>) =>
        inner.start(host).map((serving) => ({
          drain: serving.drain,
          // Held open so the probe socket is still listening when the round
          // trip below lands — `disposeProbes` runs only once `stop` settles.
          stop: () => fromSafePromise(stopGate.promise).flatMap(() => serving.stop()),
        })),
    };

    const app = start(runtimeModule(held), { probes: { port: 0 }, onEvent: () => {} });

    await inner.untilStarted();
    const port = await boundPort(app);
    expect(await get(port, "/readyz")).toEqual({ status: 200, body: "ready" });

    process.emit("uncaughtException", new Error("boom"));

    // Read in the same synchronous turn as the handler: the tracker has not
    // moved off `"serving"`, so a `ready()` consulting the phase alone would
    // still answer true. This single tick is the entire reason the
    // `forcedUnready` latch exists, and no round trip can observe it.
    expect(app.phase()).toBe("serving");
    expect(app.ready()).toBe(false);

    // And the endpoint answers from that same predicate.
    expect((await get(port, "/readyz")).status).toBe(503);

    stopGate.resolve(undefined);
    await app.exited;
  });

  it("readiness never returns to 200 once forced false", async () => {
    const clock = createFakeClock();
    const stopGate = Promise.withResolvers<void>();
    const inner = testRuntime();
    const held = {
      ...inner,
      start: (host: RuntimeHost<never>) =>
        inner.start(host).map((serving) => ({
          drain: serving.drain,
          stop: () => fromSafePromise(stopGate.promise).flatMap(() => serving.stop()),
        })),
    };

    const app = start(runtimeModule(held), {
      clock,
      signals: false,
      probes: { port: 0 },
      onEvent: () => {},
    });

    await inner.untilStarted();
    const port = await boundPort(app);
    expect((await get(port, "/readyz")).status).toBe(200);

    app.requestDrain();
    expect((await get(port, "/readyz")).status).toBe(503);

    await clock.advance(5_000);
    await clock.advance(20_000);

    // Through the whole drain and into `stopping`, with the socket still open
    // because `stop` is held: nothing anywhere resets the latch.
    expect(app.phase()).toBe("stopping");
    expect(app.ready()).toBe(false);
    expect((await get(port, "/readyz")).status).toBe(503);

    stopGate.resolve(undefined);
    await app.exited;
  });

  it("both dispose sites close the probe socket", async () => {
    const runtime = testRuntime();
    const app = start(runtime.module, {
      signals: false,
      probes: { port: 0 },
      onEvent: () => {},
    });

    await runtime.untilStarted();
    const cleanPort = await boundPort(app);
    app.stop();
    await app.exited;

    await expect(get(cleanPort, "/livez")).rejects.toThrow();

    // The other site: `Module.scoped`'s `tapFailure`, reached when the runtime
    // refuses to start after the probe server is already up.
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "nope" })),
    };
    const failing = start(runtimeModule(broken), {
      signals: false,
      probes: { port: 0 },
      onEvent: () => {},
    });

    const failedPort = await boundPort(failing);
    await expect(failing.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "broken" }),
    );

    await expect(get(failedPort, "/livez")).rejects.toThrow();
  });

  it("binds 9000 when no probe port is given", async () => {
    const runtime = testRuntime();
    // `env: {}` — the default is the kernel's, not whatever `PROBE_PORT` the
    // shell running this suite carries.
    const app = start(runtime.module, { env: {}, signals: false, onEvent: () => {} });

    // Asserted positively — the bound port IS 9000 and answers there — rather
    // than inferred from a deliberate conflict, which proved the default only by
    // implication and failed on any machine already using the port.
    await expect(app.probePort()).toBeOkWith(9000);
    expect(await get(9000, "/livez")).toEqual({ status: 200, body: "ok" });

    await runtime.untilStarted();
    app.stop();
    await app.exited;
  });

  it("a bind failure stops the graph being built and still disposes the handlers", async () => {
    const blocker = await occupy(0);
    const before = handlerCounts();
    let built = false;
    const Watched = Module("Watched")({
      imports: [testRuntime().module],
      provides: [
        Provider(Greeting)({
          make: () => {
            built = true;
            return OkAsync({ text: "hi" });
          },
        }),
      ],
      exports: [Greeting, TestRuntimePort],
    });

    const app = start(Watched, {
      probes: { port: blocker.port },
      onEvent: () => {},
    });

    // Installed synchronously by `start`, before the bind is attempted.
    // Asserting the rise is what makes the fall below mean something: a `start`
    // that never installed one would satisfy "back to baseline" on its own.
    expect(handlerCounts()).toEqual(allRaisedFrom(before));

    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "probes" }),
    );

    expect(built).toBe(false);
    expect(app.phase()).toBe("exited");
    expect(handlerCounts()).toEqual(before);
    // The failure route out of the bind attempt still settles `probePort`, so
    // a caller awaiting it cannot hang. (The success route is asserted by
    // every `probes: { port: 0 }` test above, via `boundPort`.)
    await expect(app.probePort()).toBeOkWith(undefined);

    await blocker.close();
  });
});
