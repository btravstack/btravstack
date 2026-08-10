import { Err, Ok } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { runMain } from "./run-main.js";
import type { ExitReport } from "./start.js";

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

describe("runMain", () => {
  it("exits 0 on a clean report", async () => {
    const codes: number[] = [];

    await runMain(appWith(Ok(clean).toAsync()), (code) => codes.push(code));

    expect(codes).toEqual([0]);
  });

  it("exits 0 when the drain finished with nothing abandoned", async () => {
    const codes: number[] = [];

    await runMain(
      appWith(
        Ok({
          ...clean,
          drain: { inFlightAtStart: 3, completed: 3, abandoned: 0 },
        }).toAsync(),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([0]);
  });

  it("exits 2 when work was abandoned", async () => {
    const codes: number[] = [];

    await runMain(
      appWith(
        Ok({
          ...clean,
          drain: { inFlightAtStart: 3, completed: 1, abandoned: 2 },
        }).toAsync(),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([2]);
  });

  it("exits 1 on a startup failure", async () => {
    const codes: number[] = [];

    await runMain(appWith(Err("no-config").toAsync()), (code) => codes.push(code));

    expect(codes).toEqual([1]);
  });

  it("exits 70 on a defect", async () => {
    const codes: number[] = [];

    await runMain(
      appWith(
        Ok(clean)
          .toAsync()
          .map(() => {
            throw new Error("boom");
          }),
      ),
      (code) => codes.push(code),
    );

    expect(codes).toEqual([70]);
  });

  it("sets process.exitCode when no exit callback is supplied", async () => {
    const previous = process.exitCode;

    await runMain(appWith(Ok(clean).toAsync()));

    expect(process.exitCode).toBe(0);
    process.exitCode = previous;
  });

  it("never calls process.exit", async () => {
    const codes: number[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runMain(appWith(Ok(clean).toAsync()), (code) => codes.push(code));

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
