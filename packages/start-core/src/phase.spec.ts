import { describe, expect, it } from "vitest";

import { createPhaseTracker } from "./phase.js";

describe("createPhaseTracker", () => {
  it("starts in building and reports each advance", () => {
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));

    expect(tracker.current()).toBe("building");
    expect(tracker.advanceTo("serving")).toBe(true);
    expect(tracker.current()).toBe("serving");
    expect(seen).toEqual(["serving"]);
  });

  it("refuses to move backwards and reports nothing", () => {
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));
    tracker.advanceTo("stopping");

    expect(tracker.advanceTo("draining")).toBe(false);
    expect(tracker.current()).toBe("stopping");
    expect(seen).toEqual(["stopping"]);
  });

  it("treats re-entering the same phase as a no-op", () => {
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));
    tracker.advanceTo("draining");

    expect(tracker.advanceTo("draining")).toBe(false);
    expect(seen).toEqual(["draining"]);
  });
});
