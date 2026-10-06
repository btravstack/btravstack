import { describe, expect, it } from "vitest";

import { createPhaseTracker } from "./phase.js";

describe("createPhaseTracker", () => {
  it("starts in building and reports each advance", () => {
    // GIVEN
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));

    // THEN it starts in building
    expect(tracker.current()).toBe("building");
    // WHEN it advances to serving
    // THEN the move is accepted, current and reported
    expect(tracker.advanceTo("serving")).toBe(true);
    expect(tracker.current()).toBe("serving");
    expect(seen).toEqual(["serving"]);
  });

  it("refuses to move backwards and reports nothing", () => {
    // GIVEN
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));
    tracker.advanceTo("stopping");

    // WHEN it is asked to move back to draining
    // THEN
    expect(tracker.advanceTo("draining")).toBe(false);
    expect(tracker.current()).toBe("stopping");
    expect(seen).toEqual(["stopping"]);
  });

  it("treats re-entering the same phase as a no-op", () => {
    // GIVEN
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));
    tracker.advanceTo("draining");

    // WHEN it is asked to enter draining again
    // THEN
    expect(tracker.advanceTo("draining")).toBe(false);
    expect(seen).toEqual(["draining"]);
  });
});
