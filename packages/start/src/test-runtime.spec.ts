import { Context } from "@btravstack/di";
import { Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import type { RunUnit } from "./runtime.js";
import { testRuntime } from "./test-runtime.js";
import type { UnitMeta } from "./units.js";
import { createUnitRegistry } from "./units.js";

// `registry.run`'s work takes `(signal)`; a `RunUnit`'s takes `(ctx, signal)`.
// The kernel is what closes over the context and adapts between them — this
// stub does the same thing `start.ts` does in Task 7.
const hostFor = (registry = createUnitRegistry()) => {
  const ctx = Context.empty();
  return {
    ctx,
    run: (<T, E>(meta: UnitMeta, work: (c: typeof ctx, s: AbortSignal) => never) =>
      registry.run<T, E>(meta, (signal) => work(ctx, signal))) as RunUnit<never>,
  };
};

describe("testRuntime", () => {
  it("starts and reports itself started", async () => {
    const runtime = testRuntime();
    const serving = await runtime.start(hostFor());

    expect(serving).toBeOk();
    expect(runtime.started()).toBe(true);
  });

  it("routes submitted work through the registry", async () => {
    const registry = createUnitRegistry();
    const runtime = testRuntime();
    await runtime.start(hostFor(registry));

    const unit = runtime.submit();
    expect(registry.inFlight()).toBe(1);

    unit.settle(Ok("done"));
    await expect(unit.result).toBeOkWith("done");
    expect(registry.inFlight()).toBe(0);
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
});
