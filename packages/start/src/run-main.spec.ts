import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { createFakeClock } from "./fake-clock.js";
import { runMain } from "./run-main.js";
import { start, type ExitReport } from "./start.js";
import { testRuntime } from "./test-runtime.js";

const clean: ExitReport = {
  reason: "signal",
  drain: undefined,
  teardownErrors: [],
  uptimeMs: 1,
};

// The kernel's own machinery is irrelevant here: `runMain` reads exactly one
// thing off a `RunningApp`, so a stub carrying only `exited` is the honest
// fixture.
const appWith = (exited: unknown) => ({ exited, stop: () => {}, phase: () => "exited" }) as never;

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

describe("runMain", () => {
  it("exits 0 on a clean report", async () => {
    const codes: number[] = [];

    await runMain(appWith(OkAsync(clean)), (code) => codes.push(code));

    expect(codes).toEqual([0]);
  });

  it("exits 0 when the drain finished with nothing abandoned", async () => {
    const codes: number[] = [];

    await runMain(
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

    await runMain(
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

  it("exits 70 when an uncaught exception stopped the application", async () => {
    const codes: number[] = [];

    // Installing an `uncaughtException` handler suppresses Node's own default
    // exit code of 1, so without this row a crashed process would report
    // success to its orchestrator.
    await runMain(appWith(OkAsync({ ...clean, reason: "uncaught" })), (code) => codes.push(code));

    expect(codes).toEqual([70]);
  });

  it("lets an uncaught reason outrank abandoned work", async () => {
    const codes: number[] = [];

    // The uncaught path skips the drain, so a report carrying both is not
    // reachable today — the precedence is asserted so it stays deliberate
    // rather than an accident of the order the conditions happen to be in.
    await runMain(
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

    await runMain(appWith(ErrAsync("no-config")), (code) => codes.push(code));

    expect(codes).toEqual([1]);
  });

  it("exits 70 on a defect", async () => {
    const codes: number[] = [];

    await runMain(
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

  it("sets process.exitCode when no exit callback is supplied", async () => {
    const previous = process.exitCode;

    await runMain(appWith(OkAsync(clean)));

    expect(process.exitCode).toBe(0);
    process.exitCode = previous;
  });

  it("never calls process.exit", async () => {
    const codes: number[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runMain(appWith(OkAsync(clean)), (code) => codes.push(code));

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // Every case above feeds `runMain` a hand-built report. This one drives a
  // real application all the way to an abandoned-work drain, so the `2` is
  // produced by the kernel rather than asserted against a fixture — the whole
  // chain, from a unit left open at the deadline through `DrainReport` and
  // `ExitReport` to the exit code.
  it("yields 2 from a real application whose drain abandoned work", async () => {
    const codes: number[] = [];
    const clock = createFakeClock();
    const runtime = testRuntime();
    const app = start(AppModule, {
      runtime,
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

    await runMain(app, (code) => codes.push(code));

    expect(await app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
    expect(codes).toEqual([2]);
  });
});
