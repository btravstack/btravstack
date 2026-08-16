import { Module, Port, Provider } from "@btravstack/di";
import { createFakeClock, testRuntime, TestRuntimePort } from "@btravstack/testing";
import { Err, ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { awaitExit, runMain } from "./run-main.js";
import { start, type ExitReport } from "./start.js";

const clean: ExitReport = {
  reason: "signal",
  drain: undefined,
  teardownErrors: [],
  uptimeMs: 1,
};

// The kernel's own machinery is irrelevant to the code table: `awaitExit`
// reads exactly one thing off a `RunningApp`, so a stub carrying only
// `exited` is the honest fixture. The public `runMain` — which boots the
// kernel for real — is driven at the end of the suite.
const appWith = (exited: unknown) => ({ exited, stop: () => {}, phase: () => "exited" }) as never;

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

// `runMain` boots for real, so every call needs a runtime — fresh each time,
// since a `testRuntime` is stateful across starts — and the harness options a
// spec always passes to `start`.
const failing = () =>
  Module("Failing")({
    imports: [testRuntime().module],
    provides: [Provider(Greeting)({ make: () => Err("no-config" as const) })],
    exports: [Greeting, TestRuntimePort],
  });

const quiet = { signals: false as const, probes: false as const, onEvent: () => {} };

describe("runMain", () => {
  it("exits 0 on a clean report", async () => {
    const codes: number[] = [];

    await awaitExit(appWith(OkAsync(clean)), (code) => codes.push(code));

    expect(codes).toEqual([0]);
  });

  it("exits 0 when the drain finished with nothing abandoned", async () => {
    const codes: number[] = [];

    await awaitExit(
      appWith(
        OkAsync({
          ...clean,
          drain: { inFlightAtStart: 3, completed: 3, abandoned: 0 },
        }),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([0]);
  });

  it("exits 2 when work was abandoned", async () => {
    const codes: number[] = [];

    await awaitExit(
      appWith(
        OkAsync({
          ...clean,
          drain: { inFlightAtStart: 3, completed: 1, abandoned: 2 },
        }),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([2]);
  });

  it("exits 2 when a finaliser failed during teardown", async () => {
    // GIVEN a shutdown that drained cleanly but whose finalisers did not — a
    // connection pool that could not flush is the motivating case.
    const codes: number[] = [];

    // WHEN the outcome is turned into an exit code
    await awaitExit(
      appWith(
        OkAsync({
          ...clean,
          drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
          teardownErrors: [{ port: "Database", cause: new Error("pool did not flush") }],
        }),
      ),
      (code) => codes.push(code),
    );

    // THEN it is not `0`. The kernel goes to real trouble to keep these errors
    // observable (the load-bearing array aliasing in `start.ts`); reporting
    // success for a shutdown that lost data would waste that entirely.
    expect(codes).toEqual([2]);
  });

  it("exits 70 when an uncaught exception stopped the application", async () => {
    const codes: number[] = [];

    // Installing an `uncaughtException` handler suppresses Node's own default
    // exit code of 1, so without this row a crashed process would report
    // success to its orchestrator.
    await awaitExit(appWith(OkAsync({ ...clean, reason: "uncaught" })), (code) => codes.push(code));

    expect(codes).toEqual([70]);
  });

  it("lets an uncaught reason outrank abandoned work", async () => {
    const codes: number[] = [];

    // The uncaught path skips the drain, so a report carrying both is not
    // reachable today — the precedence is asserted so it stays deliberate
    // rather than an accident of the order the conditions happen to be in.
    await awaitExit(
      appWith(
        OkAsync({
          ...clean,
          reason: "uncaught",
          drain: { inFlightAtStart: 3, completed: 1, abandoned: 2 },
        }),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([70]);
  });

  it("exits 1 on a startup failure", async () => {
    const codes: number[] = [];

    await awaitExit(appWith(ErrAsync("no-config")), (code) => codes.push(code));

    expect(codes).toEqual([1]);
  });

  it("exits 70 on a defect", async () => {
    const codes: number[] = [];

    await awaitExit(
      appWith(
        OkAsync(clean).map(() => {
          // oxlint-disable-next-line unthrown/no-throw -- a `Defect` has no public constructor by design, so a throw caught by a combinator's throw-to-defect net is the only way to hand `runMain` the defect this row asserts
          throw new Error("boom");
        }),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([70]);
  });

  // The rows above pin the code table through `awaitExit`; the rest drive the
  // public `runMain`, which boots the kernel itself. A module whose provider
  // fails is the cheapest deterministic outcome: `start`'s build stops there,
  // the runtime never starts, and `exited` settles without a clock or a
  // signal in sight.
  it("boots the module it is given and maps its startup failure to 1", async () => {
    // GIVEN a module whose only provider fails to construct
    const codes: number[] = [];

    // WHEN the process is run through the front door
    await runMain(failing(), quiet, (code) => codes.push(code));

    // THEN the modeled Err came back out as the startup exit code — proof the
    // module and options actually reached `start`
    expect(codes).toEqual([1]);
  });

  it("sets process.exitCode when no exit callback is supplied", async () => {
    // GIVEN the default exit sink
    const previous = process.exitCode;

    // WHEN runMain is called without one
    await runMain(failing(), quiet);

    // THEN the code landed on process.exitCode itself
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
  });

  it("never calls process.exit", async () => {
    // GIVEN a spy that would catch the one call this package must never make
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    // WHEN a whole boot-and-exit cycle runs
    await runMain(failing(), quiet, () => {});

    // THEN the fate was decided through the exit sink alone
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // This one drives a real application all the way to an abandoned-work
  // drain, so the `2` is produced by the kernel rather than asserted against
  // a fixture — the whole chain, from a unit left open at the deadline
  // through `DrainReport` and `ExitReport` to the exit code. It holds the
  // `RunningApp` to drive the drain, which is exactly the case `start` +
  // `awaitExit` exist for.
  it("yields 2 from a real application whose drain abandoned work", async () => {
    const codes: number[] = [];
    const clock = createFakeClock();
    const runtime = testRuntime();
    const app = start(runtime.module, {
      clock,
      signals: false,
      probes: false,
      onEvent: () => {},
    });

    await runtime.untilStarted();
    runtime.submit<string>();

    app.requestDrain();
    await clock.advance(5_000);
    await clock.advance(20_000);

    await awaitExit(app, (code) => codes.push(code));

    expect(await app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
    expect(codes).toEqual([2]);
  });
});
