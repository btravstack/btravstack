import { describe, expect, it } from "vitest";

import { installSignalHandlers, installUncaughtHandlers } from "./process-handlers.js";

const listenerCount = (): number =>
  process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

describe("installSignalHandlers", () => {
  it("calls onFirst for the first signal and onSecond for the next", () => {
    // GIVEN
    const seen: string[] = [];
    const dispose = installSignalHandlers({
      onFirst: () => seen.push("first"),
      onSecond: () => seen.push("second"),
    });

    // WHEN
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");

    // THEN
    expect(seen).toEqual(["first", "second", "second"]);
    dispose();
  });

  it("removes every listener it added", () => {
    // GIVEN
    const before = listenerCount();
    // WHEN they are installed
    const dispose = installSignalHandlers({ onFirst: () => {}, onSecond: () => {} });

    // THEN
    expect(listenerCount()).toBe(before + 2);
    // WHEN they are disposed
    dispose();
    // THEN
    expect(listenerCount()).toBe(before);
  });
});

describe("installUncaughtHandlers", () => {
  it("reports an uncaught exception once", () => {
    // GIVEN
    const seen: unknown[] = [];
    const dispose = installUncaughtHandlers((cause) => seen.push(cause));
    const error = new Error("boom");

    // WHEN
    process.emit("uncaughtException", error);
    process.emit("uncaughtException", new Error("second"));

    // THEN
    expect(seen).toEqual([error]);
    dispose();
  });

  it("reports an unhandled rejection", () => {
    // GIVEN
    const seen: unknown[] = [];
    const dispose = installUncaughtHandlers((cause) => seen.push(cause));

    // WHEN
    process.emit("unhandledRejection", "reason", Promise.resolve());

    // THEN
    expect(seen).toEqual(["reason"]);
    dispose();
  });

  it("removes every listener it added", () => {
    // GIVEN
    const before =
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
    // WHEN they are installed
    const dispose = installUncaughtHandlers(() => {});

    // THEN
    expect(
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"),
    ).toBe(before + 2);
    // WHEN they are disposed
    dispose();
    // THEN
    expect(
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"),
    ).toBe(before);
  });
});
