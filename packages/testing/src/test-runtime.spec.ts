import type { RunUnit, RuntimeHost, UnitHost } from "@btravstack/core";
import { Context, Module } from "@btravstack/di";
import { Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it } from "vitest";

import { testRuntime } from "./test-runtime.js";

// A `RuntimeHost` sized for the double: the kernel's registry counts open
// units and hands each an `AbortSignal`; this stub does the same in a dozen
// lines, so the runtime can be started without booting a kernel around it.
// `fork` is a real (if minimal) `Module.forkScope` over the empty context, so
// a runtime bound to a unit module can actually be exercised against it.
const hostFor = (
  signal = new AbortController().signal,
): RuntimeHost<never> & { readonly inFlight: () => number } => {
  const ctx = Context.empty();
  const fork: UnitHost<never>["fork"] = (module, seed) =>
    Module.forkScope(ctx, module as never, (forked) => OkAsync(forked), {
      seed: seed as never,
    }) as never;
  let inFlight = 0;
  const run: RunUnit<never> = (_meta, work) => {
    inFlight += 1;
    return fromSafePromise(
      Promise.resolve(work({ ctx, fork }, signal)).finally(() => {
        inFlight -= 1;
      }),
    ).flatMap((result) => result);
  };
  return { ctx, run, inFlight: () => inFlight };
};

describe("testRuntime", () => {
  it("starts, and reports itself started", async () => {
    // GIVEN a fresh in-memory runtime
    const runtime = testRuntime();

    // WHEN the kernel starts it
    // THEN it hands back a `Serving` and says so — one assertion over both,
    // since `started()` read after a failed start would prove nothing
    await expect(runtime.start(hostFor()).map(() => runtime.started())).toBeOkWith(true);
  });

  it("routes submitted work through the host, and releases it when it settles", async () => {
    // GIVEN a started runtime with one unit open
    const host = hostFor();
    const runtime = testRuntime();
    await runtime.start(host);
    const unit = runtime.submit();
    const during = host.inFlight();

    // WHEN the unit settles
    unit.settle(Ok("done"));

    // THEN the work's own `Result` comes back, and the unit was counted for
    // exactly as long as it was open
    await expect(
      unit.result.map((value) => ({ value, during, after: host.inFlight() })),
    ).toBeOkWith({ value: "done", during: 1, after: 0 });
  });

  // The fixture's two misuse guards are loud on purpose — a test that forgot
  // to start the runtime is a bug in the test, not a modeled outcome, so it
  // must not be routed into a `Result` a careless assertion could swallow.
  it("is loud when asked for a Serving it has not produced yet", () => {
    const runtime = testRuntime();

    expect(runtime.started()).toBe(false);
    expect(() => runtime.serving()).toThrow("not started");
  });

  it("refuses work after drain has begun", async () => {
    const runtime = testRuntime();
    await runtime.start(hostFor());
    const serving = runtime.serving();

    void serving.drain(new AbortController().signal);

    expect(() => runtime.submit()).toThrow("not accepting");
  });

  it("forwards the unit's abort to the submitted unit's own signal", async () => {
    // GIVEN a host that opens units already aborted (a drain deadline passed)
    const runtime = testRuntime();
    await runtime.start(hostFor(AbortSignal.abort("deadline")));

    // WHEN work is submitted
    const unit = runtime.submit();

    // THEN its signal is aborted, with the host's reason
    expect({ aborted: unit.signal.aborted, reason: unit.signal.reason }).toEqual({
      aborted: true,
      reason: "deadline",
    });
  });

  it("forwards an abort that fires while the unit is open", async () => {
    // GIVEN a host whose units abort on demand
    const controller = new AbortController();
    const runtime = testRuntime();
    await runtime.start(hostFor(controller.signal));
    const unit = runtime.submit();

    // WHEN the host aborts the open unit
    controller.abort("later");

    // THEN the submitted unit's signal followed
    expect(unit.signal.reason).toBe("later");
  });

  it("reports whether it is accepting, before and after the drain", async () => {
    const runtime = testRuntime();
    await runtime.start(hostFor());
    const before = runtime.accepting();

    void runtime.serving().drain(new AbortController().signal);

    expect({ before, after: runtime.accepting() }).toEqual({ before: true, after: false });
  });

  it("is loud when asked for a host it has not started with", () => {
    // GIVEN a runtime that has not been started
    const runtime = testRuntime();

    // WHEN / THEN asking for its host is loud, not silently `undefined`
    expect(() => runtime.host()).toThrow("not started");
  });

  it("hands back the RuntimeHost it was last started with", async () => {
    // GIVEN a runtime started with a given host
    const host = hostFor();
    const runtime = testRuntime();

    // WHEN it is started
    await runtime.start(host);

    // THEN `host()` returns that very host
    expect(runtime.host()).toBe(host);
  });

  it("forks the bound unit module before the work runs", async () => {
    // GIVEN a runtime bound to a unit module, with one unit submitted
    const UnitModule = Module("SpecUnit")({ provides: [], exports: [] });
    const runtime = testRuntime("with-unit", { unit: UnitModule });
    await runtime.start(hostFor());
    const unit = runtime.submit<string>();

    // WHEN the unit settles
    unit.settle(Ok("done"));

    // THEN the work's own result still comes back, once the fork resolved
    await expect(unit.result).toBeOkWith("done");
  });
});
