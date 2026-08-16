import { createServer } from "node:net";

import { Module, Port, Provider } from "@btravstack/di";
import { createFakeClock, testRuntime, TestRuntimePort, withApp } from "@btravstack/testing";
import { ErrAsync, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { createDeferred } from "./deferred.js";
import { RuntimeStartFailed, type RuntimeHost } from "./runtime.js";
import { start, type RunningApp } from "./start.js";
import { runtimeModule } from "./test-fixtures.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
};

const boundPort = async (app: RunningApp<never, unknown>): Promise<number> => {
  const port = (await app.probePort()).get();
  if (port === undefined) {
    // oxlint-disable-next-line unthrown/no-throw -- a test-only fixture: reaching here means the probe server never bound, which is a bug in the test's setup rather than a modeled outcome, and routing it would make every call site handle a case that only ever means "the test is broken"
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
  // 1. Readiness goes false before the runtime stops accepting.
  //    Asserted end-to-end through the real probe endpoint, in
  //    "the drain flips readiness false before the runtime stops accepting"
  //    below — the ordering only means something if `/readyz` is what an
  //    orchestrator would actually see. `drain.spec.ts`'s "flips readiness
  //    false, waits preDrainDelayMs, then tells the runtime to stop accepting
  //    — in that order" pins the same ordering inside `drainApp`.

  it("2. in-flight units complete when the drain has time for them", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();

    const report = await withApp(runtime.module, { clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      const unit = runtime.submit<string>();

      app.requestDrain();
      await clock.advance(5_000);

      unit.settle(Ok("done"));
      await unit.result;

      return await app.exited;
    });

    // `drain.spec.ts` proves the accounting inside `drainApp`; what this adds
    // is the kernel's wiring — a unit submitted through the runtime's own
    // `RunUnit` adapter lands in the registry the drain counts, and the count
    // reaches `ExitReport.drain`.
    expect(report).toBeOkWith(
      expect.objectContaining({
        reason: "signal",
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });

  it("3. units still open at the deadline are counted as abandoned", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();

    const report = await withApp(runtime.module, { clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      runtime.submit<string>();

      app.requestDrain();
      await clock.advance(5_000);
      await clock.advance(20_000);

      return await app.exited;
    });

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
  });

  it("4. the unit AbortSignal fires at the drain deadline", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();
    let aborted = false;

    await withApp(runtime.module, { clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      const unit = runtime.submit<string>();
      unit.signal.addEventListener("abort", () => {
        aborted = true;
      });

      app.requestDrain();
      await clock.advance(5_000);
      expect(aborted).toBe(false);

      await clock.advance(20_000);
      return await app.exited;
    });

    // The abort comes from `registry.abortAll()` at the deadline, not from the
    // runtime honouring `Serving.drain(signal)` — `testRuntime` deliberately
    // ignores that signal, which is what makes this a test of the kernel.
    expect(aborted).toBe(true);
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

    // `start.spec.ts`'s "closes the application scope on a clean stop" covers
    // the happy path; this is the other one — a failure short-circuits past
    // `finish`, and the scope still closes.
    expect(released).toEqual(["greeting"]);
  });

  // 6. A second signal skips the drain.
  //    Covered by `start.spec.ts`'s "drains on SIGTERM and skips the drain on
  //    a second signal", which emits both signals against real handlers and
  //    asserts the exit does not wait out the 60s timeouts.

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

    // `start.spec.ts`'s "surfaces a failing release in the exit report's
    // teardown errors" proves they are collected. What this adds is the other
    // half of the invariant: a failing finaliser does not turn the exit into a
    // failure, nor rewrite the reason the application stopped.
    expect(await app.exited).toBeOkWith(
      expect.objectContaining({
        reason: "signal",
        drain: { inFlightAtStart: 0, completed: 0, abandoned: 0 },
        teardownErrors: [{ port: "Greeting", cause: boom }],
      }),
    );
  });

  it("8. start neither throws nor calls process.exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const runtime = testRuntime();

    await withApp(runtime.module, { onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      // `untilStarted` resolves from inside `Runtime.start`, before the
      // kernel's own continuation advances the tracker — so the live phase
      // here is `"starting"` or `"serving"`, never a terminal one.
      expect(app.phase()).not.toBe("exited");
      expect(runtime.started()).toBe(true);
    });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // 9. Signal listeners are removed on exit.
  //    Covered twice in `start.spec.ts`: "drains on SIGTERM and skips the drain
  //    on a second signal" asserts the SIGTERM/SIGINT count returns to its
  //    baseline, and "skips the drain and marks itself unready on an uncaught
  //    exception" does the same for uncaughtException/unhandledRejection. The
  //    bind-failure route is the one they do not reach; it is asserted in
  //    "a bind failure stops the graph being built and still disposes the
  //    handlers" below.
});

describe("probe wiring", () => {
  it("readiness is false while the graph is still building", async () => {
    const gate = createDeferred<void>();
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
    const gate = createDeferred<void>();
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

    // A `fetch` is a macrotask, so the drain's first beat has certainly run by
    // the time this lands. Its pre-drain delay is still pending on the fake
    // clock, so the runtime has not yet been told to stop accepting: readiness
    // goes false strictly first, which is the whole point of the delay.
    //
    // Note which mechanism answers here: `runDrain` advances the tracker to
    // `"draining"` synchronously before `drainApp` calls `onUnready`, so on
    // this path the phase term of `ready()` alone already returns false and
    // the `forcedUnready` latch changes nothing. This test therefore does NOT
    // guard the latch (deleting it leaves this green) — it guards the
    // *ordering*, and fails if the pre-drain delay that creates the window is
    // removed. The latch is guarded solely by the uncaught-exception test
    // below, the one path where the phase is still `"serving"` when readiness
    // flips. See the comment on `ready()` in `start.ts`.
    expect((await get(port, "/readyz")).status).toBe(503);
    expect(runtime.accepting()).toBe(true);

    await clock.advance(5_000);
    expect(runtime.accepting()).toBe(false);

    await app.exited;
  });

  it("an uncaught exception forces readiness false while the phase is still serving", async () => {
    const stopGate = createDeferred<void>();
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
    // moved off `"serving"` yet, so a `ready()` that consulted the phase alone
    // would still answer true here. This single tick is the entire reason the
    // `forcedUnready` latch exists, and no HTTP round trip can observe it —
    // hence the synchronous accessor.
    expect(app.phase()).toBe("serving");
    expect(app.ready()).toBe(false);

    // And the endpoint answers from that same predicate.
    expect((await get(port, "/readyz")).status).toBe(503);

    stopGate.resolve(undefined);
    await app.exited;
  });

  it("readiness never returns to 200 once forced false", async () => {
    const clock = createFakeClock();
    const stopGate = createDeferred<void>();
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
    // shell running this suite happens to carry.
    const app = start(runtime.module, { env: {}, signals: false, onEvent: () => {} });

    // Asserted positively — the bound port *is* 9000, and answers there —
    // rather than inferred from a deliberate conflict on 9000, which proved
    // the default only by implication and failed outright on any machine
    // already using the port. The residual coupling is the honest one: this
    // needs 9000 to be free, where the old shape needed it to be free *and*
    // then took it.
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

    // Installed synchronously by `start`, before the bind is even attempted.
    // Asserting the rise is what makes the fall below mean something: a
    // `start` that never installed a handler at all would satisfy the
    // "back to baseline" check on its own.
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
