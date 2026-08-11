import { ErrAsync, Ok, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { currentUnit } from "./ambient.js";
import { createUnitRegistry } from "./units.js";

const meta = { kind: "test", id: "1" };

describe("createUnitRegistry", () => {
  it("returns the work's result unchanged", async () => {
    const registry = createUnitRegistry();
    await expect(registry.run(meta, () => OkAsync(42))).toBeOkWith(42);
  });

  it("passes the error channel through", async () => {
    const registry = createUnitRegistry();
    await expect(registry.run(meta, () => ErrAsync("nope" as const))).toBeErrWith("nope");
  });

  it("counts a unit as in flight until it settles", async () => {
    const registry = createUnitRegistry();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = registry.run(meta, async () => {
      await held;
      return Ok("done");
    });

    expect(registry.inFlight()).toBe(1);
    release();
    await running;
    expect(registry.inFlight()).toBe(0);
  });

  it("decrements even when the work throws", async () => {
    const registry = createUnitRegistry();

    await expect(
      registry.run(meta, () => {
        // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject under test: a unit must be counted closed on the throw-to-defect path too
        throw new Error("boom");
      }),
    ).toBeDefect();
    expect(registry.inFlight()).toBe(0);
  });

  it("exposes the ambient record to the work", async () => {
    const registry = createUnitRegistry();

    const seen = await registry.run({ ...meta, tenantId: "acme" }, () => OkAsync(currentUnit()));

    expect(seen).toBeOkWith(expect.objectContaining({ tenantId: "acme" }));
  });

  it("nests correctly through the registry", async () => {
    const registry = createUnitRegistry();

    const outerSeen: unknown[] = [];

    const running = registry.run({ kind: "outer", id: "o" }, async () => {
      outerSeen.push(currentUnit());

      const innerResult = await registry.run({ kind: "inner", id: "i" }, () =>
        OkAsync(currentUnit()),
      );

      outerSeen.push(currentUnit());

      return Ok(innerResult.get());
    });

    const result = await running;

    expect(result).toBeOkWith(expect.objectContaining({ traceId: "i" }));
    expect(outerSeen).toHaveLength(2);
    expect(outerSeen[0]).toEqual(outerSeen[1]);
    expect(outerSeen[0]).toEqual(expect.objectContaining({ traceId: "o" }));
  });

  it("aborts every open unit on abortAll", async () => {
    const registry = createUnitRegistry();
    let abortedA = false;
    let abortedB = false;

    const runA = registry.run({ kind: "test", id: "a" }, async (signal) => {
      signal.addEventListener("abort", () => {
        abortedA = true;
      });
      await Promise.resolve();
      return Ok("done");
    });
    const runB = registry.run({ kind: "test", id: "b" }, async (signal) => {
      signal.addEventListener("abort", () => {
        abortedB = true;
      });
      await Promise.resolve();
      return Ok("done");
    });

    registry.abortAll();
    await Promise.all([runA, runB]);
    expect(abortedA).toBe(true);
    expect(abortedB).toBe(true);
  });

  it("awaitIdle resolves immediately when nothing is in flight", async () => {
    const registry = createUnitRegistry();
    await expect(registry.awaitIdle()).resolves.toBeUndefined();
  });

  it("awaitIdle resolves once the last unit settles", async () => {
    const registry = createUnitRegistry();
    let releaseA = (): void => {};
    let releaseB = (): void => {};
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const heldB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const runA = registry.run({ kind: "test", id: "a" }, async () => {
      await heldA;
      return Ok("done");
    });
    const runB = registry.run({ kind: "test", id: "b" }, async () => {
      await heldB;
      return Ok("done");
    });

    let idle = false;
    void registry.awaitIdle().then(() => {
      idle = true;
    });

    expect(idle).toBe(false);
    releaseA();
    await runA;
    await Promise.resolve();
    expect(idle).toBe(false);

    releaseB();
    await runB;
    await Promise.resolve();
    expect(idle).toBe(true);
  });
});
