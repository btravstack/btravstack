import { describe, expect, it } from "vitest";

import { installSignalHandlers } from "./signals.js";

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
