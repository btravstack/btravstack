import { start } from "@btravstack/core";
import { tapped } from "@btravstack/testing";
import { describe, expect } from "vitest";

import { Logger } from "./logger.js";
import { kernelEvents } from "./observability.js";
import { LoggerConfig } from "./observability.js";
import { it } from "./test-fixtures.js";

describe("the observability starter", () => {
  it("binds the level from the environment, and every logger in the graph filters at it", async ({
    app,
    boot,
    recorder,
  }) => {
    // GIVEN an application booted with LOG_LEVEL raised
    const { module, runtime } = app({ sink: recorder.sink });
    const tap = tapped(module, [Logger, LoggerConfig]);
    boot(tap.module, { env: { LOG_LEVEL: "error" } });
    await runtime.untilStarted();
    const [logger, config] = tap.services();

    // WHEN a line below that level and one at it are written
    logger.info("dropped");
    logger.error("kept");

    // THEN the graph's logger is the configured one
    expect({ level: config.level, written: recorder.lines().map((line) => line.message) }).toEqual({
      level: "error",
      written: ["kept"],
    });
  });

  it("fails startup with ConfigInvalid when LOG_LEVEL is not a level", async ({ app }) => {
    // GIVEN an application whose environment names a level that does not exist
    const { module } = app();

    // WHEN it is booted — `start` directly, since this app never serves
    const exited = await start(module, {
      env: { LOG_LEVEL: "verbose" },
      signals: false,
      probes: false,
      onEvent: () => {},
    }).exited;

    // THEN it is a modeled ConfigInvalid naming the variable and the set,
    // which `runMain` turns into exit 78 — not a silent fallback to `info`
    expect(exited).toBeErrTagged("ConfigInvalid", {
      port: "LoggerConfig",
      issues: [
        {
          message: expect.stringContaining("must be one of trace, debug, info, warn, error, fatal"),
          path: ["LOG_LEVEL"],
        },
      ],
    });
  });

  it("pins the level over the environment when a caller supplies one", async ({
    app,
    boot,
    recorder,
  }) => {
    // GIVEN a composition that pins `fatal`, and an environment that says `trace`
    const { module, runtime } = app({ sink: recorder.sink, level: "fatal" });
    const tap = tapped(module, [LoggerConfig]);
    boot(tap.module, { env: { LOG_LEVEL: "trace" } });
    await runtime.untilStarted();

    // WHEN the bound configuration is read
    // THEN explicit beat environment, per field, as every starter's pins do
    expect(tap.services().at(0)).toEqual({ level: "fatal" });
  });
});

describe("the kernel's events as log lines", () => {
  it("writes each lifecycle event once, with its own fields", async ({
    app,
    boot,
    recorder,
    loggerAt,
  }) => {
    // GIVEN an application whose `onEvent` is the logger's adapter
    const { module, runtime } = app({ sink: recorder.sink });
    const events = kernelEvents(loggerAt("trace"));
    const running = boot(module, { onEvent: events });
    await runtime.untilStarted();

    // WHEN the application stops
    running.stop();
    await running.exited;

    // THEN the transitions are lines, in order, each carrying its event name
    expect(
      recorder.lines().map((line) => ({ level: line.level, event: line.attributes["event"] })),
    ).toEqual([
      { level: "info", event: "building" },
      { level: "info", event: "serving" },
      { level: "info", event: "stopping" },
      { level: "info", event: "exited" },
    ]);
  });

  it("logs a startup failure as an error, carrying its cause", ({ loggerAt, recorder }) => {
    // GIVEN the adapter over a recording logger
    const cause = new Error("port in use");

    // WHEN a `startFailed` event reaches it
    kernelEvents(loggerAt("trace"))({ type: "startFailed", cause });

    // THEN it is an error line whose cause survives for the sink to render
    expect(recorder.only()).toEqual(
      expect.objectContaining({
        level: "error",
        message: "the application failed to start",
        cause,
        attributes: { event: "startFailed" },
      }),
    );
  });

  it("logs an uncaught exception as an error", ({ loggerAt, recorder }) => {
    // GIVEN the adapter and a crash
    const cause = new Error("boom");

    // WHEN the kernel reports it
    kernelEvents(loggerAt("trace"))({ type: "uncaught", cause });

    // THEN the line names the crash and carries it
    expect(recorder.only()).toEqual(
      expect.objectContaining({ level: "error", cause, attributes: { event: "uncaught" } }),
    );
  });

  it("logs a failed finaliser as a warning, naming the port AND why it failed", ({
    loggerAt,
    recorder,
  }) => {
    // GIVEN the adapter and a finaliser that blew up
    const cause = new Error("closed twice");

    // WHEN the teardown error reaches it
    kernelEvents(loggerAt("trace"))({ type: "teardownError", port: "Database", cause });

    // THEN it is a warning — the exit code already carries the severity — and
    // it keeps the reason, which is the whole point of every level taking a
    // cause rather than just `error` and `fatal`
    expect(recorder.only()).toEqual(
      expect.objectContaining({
        level: "warn",
        cause,
        attributes: { event: "teardownError", port: "Database" },
      }),
    );
  });

  it("keeps the drain's numbers as attributes rather than a rendered sentence", ({
    loggerAt,
    recorder,
  }) => {
    // GIVEN the adapter
    // WHEN a drain is reported
    const events = kernelEvents(loggerAt("trace"));
    events({ type: "draining", inFlight: 3 });
    events({ type: "drained", report: { inFlightAtStart: 3, completed: 2, abandoned: 1 } });

    // THEN both lines are queryable by field, which a message never is
    expect(recorder.lines().map((line) => line.attributes)).toEqual([
      { event: "draining", inFlight: 3 },
      { event: "drained", inFlightAtStart: 3, completed: 2, abandoned: 1 },
    ]);
  });
});
