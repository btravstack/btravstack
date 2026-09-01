import { describe, expect, it } from "vitest";

import { noObserver, observe, type Operation, type Settle } from "./observation.js";

describe("observe", () => {
  it("starts every observer, in order, before the operation runs", () => {
    // GIVEN two observers that record when they were started
    const started: string[] = [];
    const observer =
      (name: string) =>
      (_operation: Operation): Settle => {
        started.push(name);
        return () => {};
      };

    // WHEN one operation is observed
    observe([observer("first"), observer("second")], {
      component: "cache",
      name: "get",
      attributes: {},
    });

    // THEN both were started, in the order the set holds them — a span opened
    // by one has to be opened BEFORE the work, which is the whole reason an
    // observer is called at the start and answers a finisher
    expect(started).toEqual(["first", "second"]);
  });

  it("settles every observer exactly once, with what it was handed", () => {
    // GIVEN two observers over one operation
    const settled: { name: string; outcome: string }[] = [];
    const observer =
      (name: string) =>
      (_operation: Operation): Settle =>
      ({ outcome }) => {
        settled.push({ name, outcome });
      };
    const settle = observe([observer("first"), observer("second")], {
      component: "cache",
      name: "get",
      attributes: {},
    });

    // WHEN the one finisher is called
    settle({ outcome: "error" });

    // THEN each observer settled once. "Called exactly once" is a property of
    // this function rather than a rule every starter re-keeps
    expect(settled).toEqual([
      { name: "first", outcome: "error" },
      { name: "second", outcome: "error" },
    ]);
  });

  it("drops a second settlement, so a count cannot be doubled", () => {
    // GIVEN one observer over one operation
    let settlements = 0;
    const settle = observe(
      [
        (): Settle => () => {
          settlements += 1;
        },
      ],
      { component: "cache", name: "get", attributes: {} },
    );

    // WHEN the finisher is called twice — a `tap` and a `tapFailure` on one
    // chain, or a retry, is exactly the shape that does this
    settle({ outcome: "ok" });
    settle({ outcome: "error" });

    // THEN the operation settled once. "Called exactly once" is a property of
    // this function rather than a rule every starter re-keeps
    expect(settlements).toBe(1);
  });

  it("does nothing at all when nothing observes", () => {
    // GIVEN an empty set — impossible in a real graph, since every reader
    // contributes a no-op, but the arithmetic still has to hold
    const settle = observe([], { component: "cache", name: "get", attributes: {} });

    // WHEN it settles
    // THEN it is inert rather than a failure
    expect(() => settle({ outcome: "ok" })).not.toThrow();
  });
});

describe("noObserver", () => {
  it("is inert on both halves, so a graph with no observability pays a call", () => {
    // GIVEN the member every reader of the port contributes
    const settle = noObserver();

    // WHEN it is started and settled
    // THEN neither half does anything: the set is never empty, and never costs
    // more than the two calls
    expect({ settle: typeof settle, returned: settle({ outcome: "ok" }) }).toEqual({
      settle: "function",
      returned: undefined,
    });
  });
});
