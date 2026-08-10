import { describe, expect, it } from "vitest";

import { installUncaughtHandlers } from "./uncaught.js";

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
