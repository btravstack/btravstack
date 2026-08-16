import { RuntimeStartFailed, type RuntimeHost } from "@btravstack/core";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { runtimeModule } from "./test-fixtures.js";
import { testRuntime } from "./test-runtime.js";
import { withApp } from "./with-app.js";

const boom = new Error("boom");

// A runtime whose `stop()` hands back a defect-state `AsyncResult`. A `Defect`
// has no public constructor by design, so a throw caught by a combinator's
// throw-to-defect net is the documented way to build one — and it is exactly
// how a third-party runtime's internal throw reaches the kernel in production.
const defectingOnStop = (): ReturnType<typeof testRuntime> => {
  const inner = testRuntime();
  return {
    ...inner,
    start: (host: RuntimeHost<never>) =>
      inner.start(host).map((serving) => ({
        drain: serving.drain,
        stop: () =>
          OkAsync().map((): void => {
            // oxlint-disable-next-line unthrown/no-throw -- see above: the only documented route to a defect-state `Result`
            throw boom;
          }),
      })),
  };
};

describe("withApp", () => {
  it("surfaces a shutdown Defect that `use` never looked at", async () => {
    const runtime = defectingOnStop();

    // The harness awaits `exited` to know the application has stopped, and
    // `AsyncResult<ExitReport, never>` empties the *error* channel only — so
    // discarding that `Result` would let a shutdown that blew up pass as a
    // green test that asserted nothing.
    await expect(
      withApp(runtimeModule(runtime), { onEvent: () => {} }, async () => {
        await runtime.untilStarted();
      }),
    ).rejects.toBe(boom);
  });

  it("lets a failure thrown by `use` win over a shutdown Defect", async () => {
    const runtime = defectingOnStop();
    const assertionFailure = new Error("expected 1 to be 2");

    await expect(
      withApp(runtimeModule(runtime), { onEvent: () => {} }, async () => {
        await runtime.untilStarted();
        // oxlint-disable-next-line unthrown/no-throw -- standing in for a failing `expect`, which is what `use` throwing means
        throw assertionFailure;
      }),
    ).rejects.toBe(assertionFailure);
  });

  it("passes a modeled Err through without failing the test", async () => {
    const broken = {
      ...testRuntime(),
      start: () => ErrAsync(new RuntimeStartFailed({ runtime: "broken", cause: "nope" })),
    };

    // The complement of the defect case: a startup failure is a modeled
    // outcome a test may be asserting, so the harness does not rethrow it.
    await expect(
      withApp(runtimeModule(broken), { onEvent: () => {} }, async (app) => {
        await expect(app.exited).toBeErrTagged(
          "RuntimeStartFailed",
          expect.objectContaining({ runtime: "broken" }),
        );
        return "use ran to completion";
      }),
    ).resolves.toBe("use ran to completion");
  });
});
