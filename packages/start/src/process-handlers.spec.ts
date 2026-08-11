import { describe, expect, it } from "vitest";

import { installSignalHandlers, installUncaughtHandlers } from "./process-handlers.js";

const listenerCount = (): number =>
  process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

describe("installSignalHandlers", () => {
  it("calls onFirst for the first signal and onSecond for the next", () => {
    const seen: string[] = [];
    const dispose = installSignalHandlers({
      onFirst: () => seen.push("first"),
      onSecond: () => seen.push("second"),
    });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");

    expect(seen).toEqual(["first", "second", "second"]);
    dispose();
  });

  it("removes every listener it added", () => {
    const before = listenerCount();
    const dispose = installSignalHandlers({ onFirst: () => {}, onSecond: () => {} });

    expect(listenerCount()).toBe(before + 2);
    dispose();
    expect(listenerCount()).toBe(before);
  });
});

describe("installUncaughtHandlers", () => {
  it("reports an uncaught exception once", () => {
    const seen: unknown[] = [];
    const dispose = installUncaughtHandlers((cause) => seen.push(cause));
    const error = new Error("boom");

    process.emit("uncaughtException", error);
    process.emit("uncaughtException", new Error("second"));

    expect(seen).toEqual([error]);
    dispose();
  });

  it("reports an unhandled rejection", () => {
    const seen: unknown[] = [];
    const dispose = installUncaughtHandlers((cause) => seen.push(cause));

    process.emit("unhandledRejection", "reason", Promise.resolve());

    expect(seen).toEqual(["reason"]);
    dispose();
  });

  it("removes every listener it added", () => {
    const before =
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
    const dispose = installUncaughtHandlers(() => {});

    expect(
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"),
    ).toBe(before + 2);
    dispose();
    expect(
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"),
    ).toBe(before);
  });
});
