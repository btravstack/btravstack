import { Ok } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { createLogger } from "./logger.js";

describe("the logger", () => {
  it("writes the level, the message and the caller's attributes", ({ loggerAt, recorder }) => {
    // GIVEN a logger at the default level
    const logger = loggerAt();

    // WHEN a line is written
    logger.info("order placed", { orderId: "o-1", quantity: 2 });

    // THEN the sink sees all of it, outside a unit
    expect(recorder.only()).toEqual({
      level: "info",
      message: "order placed",
      attributes: { orderId: "o-1", quantity: 2 },
      cause: undefined,
      time: expect.any(Number),
      unit: undefined,
    });
  });

  it("drops a line below its level, and keeps one at it", ({ loggerAt, recorder }) => {
    // GIVEN a logger raised to `warn`
    const logger = loggerAt("warn");

    // WHEN one line below the floor and one at it are written
    logger.info("ignored");
    logger.warn("kept");

    // THEN only the second survives, and `isEnabled` said so in advance
    expect({
      levels: recorder.lines().map((line) => line.level),
      info: logger.isEnabled("info"),
      warn: logger.isEnabled("warn"),
    }).toEqual({ levels: ["warn"], info: false, warn: true });
  });

  it("writes one line per level, at the level its name says", ({ loggerAt, recorder }) => {
    // GIVEN a logger that keeps everything
    const logger = loggerAt("trace");
    const cause = new Error("boom");

    // WHEN every level is written through its own method
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e", undefined, cause);
    logger.fatal("f", undefined, cause);

    // THEN each lands at its own severity, and a cause appears exactly where
    // the call supplied one — every level can carry one; these two did
    expect(
      recorder.lines().map((line) => ({ level: line.level, hasCause: line.cause !== undefined })),
    ).toEqual([
      { level: "trace", hasCause: false },
      { level: "debug", hasCause: false },
      { level: "info", hasCause: false },
      { level: "warn", hasCause: false },
      { level: "error", hasCause: true },
      { level: "fatal", hasCause: true },
    ]);
  });

  it("carries a failure on its own channel, not stringified into the message", ({
    loggerAt,
    recorder,
  }) => {
    // GIVEN a logger and a failure
    const logger = loggerAt();
    const cause = new Error("the database is on fire");

    // WHEN it is logged
    logger.error("could not save the order", { orderId: "o-1" }, cause);

    // THEN the message stays the message and the cause stays the cause
    expect(recorder.only()).toEqual(
      expect.objectContaining({
        level: "error",
        message: "could not save the order",
        attributes: { orderId: "o-1" },
        cause,
      }),
    );
  });

  it("layers attributes with `with`, and never mutates the logger it came from", ({
    loggerAt,
    recorder,
  }) => {
    // GIVEN a logger and a child carrying more
    const parent = loggerAt();
    const child = parent.with({ component: "relay" });

    // WHEN both write, the child adding one of its own
    child.info("child", { step: 1 });
    parent.info("parent");

    // THEN the child's attributes are layered and the parent never saw them —
    // the defect a mutable `setContext` has, asserted rather than asserted about
    expect(recorder.lines().map((line) => line.attributes)).toEqual([
      { component: "relay", step: 1 },
      {},
    ]);
  });

  it("lets a call's own attribute win over the child's, for the same key", ({
    loggerAt,
    recorder,
  }) => {
    // GIVEN a child logger carrying a component
    const logger = loggerAt().with({ component: "relay" });

    // WHEN a call names the same key
    logger.info("overridden", { component: "sweeper" });

    // THEN the nearest one wins
    expect(recorder.only().attributes).toEqual({ component: "sweeper" });
  });

  it("swallows a sink that throws, rather than taking the caller down with it", () => {
    // GIVEN a logger whose sink is broken
    const logger = createLogger(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject under test: a broken sink must not reach the caller
      throw new Error("the log transport is gone");
    });

    // WHEN it writes
    // THEN the call returns: a logging fault is not an outage
    expect(() => logger.log("fatal", "still fine")).not.toThrow();
  });

  it("carries the unit's tenant when the runtime supplied one, and omits it otherwise", ({
    loggerAt,
    recorder,
  }) => {
    // GIVEN a logger, and a line written outside any unit
    loggerAt().info("no unit");

    // WHEN the record is read back
    // THEN there is no `unit` at all — the field is absent rather than a set
    // of empty strings, so a log backend's `traceId` facet stays honest
    expect(recorder.only().unit).toBeUndefined();
  });

  it("carries the tenant a runtime supplied, alongside the ids the kernel mints", async ({
    boot,
    recorder,
    tenantApp,
  }) => {
    // GIVEN an application whose runtime opens its unit with a tenant
    boot(tenantApp("acme", { sink: recorder.sink }));
    await vi.waitUntil(() => recorder.lines().length > 0);

    // WHEN the line it logged inside that unit is read back
    // THEN the tenant rides with the ids, for a deployment that has one
    expect(recorder.only().unit).toEqual({
      unitId: expect.any(String),
      traceId: "unit-1",
      tenantId: "acme",
    });
  });

  it("stamps a line written inside a unit with that unit's own record", async ({
    app,
    boot,
    recorder,
    unitLogging,
  }) => {
    // GIVEN a booted application whose test runtime forks a unit module that
    // logs as it is built — the shape a request-scoped span has, and the only
    // code that genuinely runs inside the kernel's ambient record
    const { module, runtime } = app({ sink: recorder.sink }, unitLogging);
    boot(module);
    await runtime.untilStarted();

    // WHEN one unit opens and settles
    const unit = runtime.submit<string, never>();
    unit.settle(Ok("done"));
    await unit.result;

    // THEN the line carries that unit's ids, and the logger was the graph's own
    expect(recorder.only()).toEqual(
      expect.objectContaining({
        message: "inside the unit",
        unit: { unitId: expect.any(String), traceId: expect.any(String) },
      }),
    );
  });
});
