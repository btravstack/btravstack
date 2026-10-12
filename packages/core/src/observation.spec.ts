import { ErrAsync, OkAsync, type AsyncResult } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { noObserver, observe, observed, type Operation, type Settle } from "./observation.js";

const operation: Operation = { component: "cache", name: "get", attributes: {} };

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
    observe([observer("first"), observer("second")], operation);

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
    const settle = observe([observer("first"), observer("second")], operation);

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
      operation,
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
    const settle = observe([], operation);

    // WHEN it settles
    // THEN it is inert rather than a failure
    expect(() => settle({ outcome: "ok" })).not.toThrow();
  });
});

describe("observed", () => {
  it("preserves success when an observer cannot start", async ({ recording }) => {
    // GIVEN an observer whose startup is broken
    const broken = (): Settle => {
      // oxlint-disable-next-line unthrown/no-throw -- a broken observer is the subject under test
      throw new Error("observer start");
    };

    // WHEN the operation is observed alongside a valid observer
    const answer = await observed([broken, recording.observer], operation, () =>
      OkAsync("committed"),
    );

    // THEN its result and the valid observer's settlement survive
    expect({ answer, settled: recording.seen }).toEqual({
      answer: expect.objectContaining({ tag: "Ok", value: "committed" }),
      settled: [{ outcome: "ok" }],
    });
  });

  it("settles later observers once when a finisher fails", async ({ recording }) => {
    // GIVEN a finisher whose destination is broken
    const broken = (): Settle => () => {
      // oxlint-disable-next-line unthrown/no-throw -- a broken observer is the subject under test
      throw new Error("observer finish");
    };

    // WHEN a committed operation is observed
    const answer = await observed([broken, recording.observer], operation, () =>
      OkAsync("committed"),
    );

    // THEN neither its success nor the later settlement is lost
    expect({ answer, settled: recording.seen }).toEqual({
      answer: expect.objectContaining({ tag: "Ok", value: "committed" }),
      settled: [{ outcome: "ok" }],
    });
  });

  it("preserves a modeled refusal when a finisher fails", async ({ recording }) => {
    // GIVEN a broken finisher and an operation that refuses
    const broken = (): Settle => () => {
      // oxlint-disable-next-line unthrown/no-throw -- a broken observer is the subject under test
      throw new Error("observer finish");
    };

    // WHEN the refusal is observed
    const answer = await observed([broken, recording.observer], operation, () =>
      ErrAsync("refused"),
    );

    // THEN the original refusal remains the operation's outcome
    expect({ answer, settled: recording.seen }).toEqual({
      answer: expect.objectContaining({ tag: "Err", error: "refused" }),
      settled: [{ outcome: "error", cause: "refused" }],
    });
  });

  it("qualifies a synchronous operation throw and preserves it through broken finishers", async ({
    recording,
  }) => {
    // GIVEN a throwing call and a broken finisher
    const cause = new Error("operation defect");
    const broken = (): Settle => () => {
      // oxlint-disable-next-line unthrown/no-throw -- a broken observer is the subject under test
      throw new Error("observer finish");
    };

    // WHEN the call throws before returning an AsyncResult
    const answer = await observed(
      [broken, recording.observer],
      operation,
      (): AsyncResult<never, never> => {
        // oxlint-disable-next-line unthrown/no-throw -- a synchronous operation defect is the subject under test
        throw cause;
      },
    );

    // THEN the original defect is preserved and every valid observer settles
    expect({ answer, settled: recording.seen }).toEqual({
      answer: expect.objectContaining({ tag: "Defect", cause }),
      settled: [{ outcome: "error", cause }],
    });
  });

  it("preserves success when its settlement hook throws", async ({ recording }) => {
    // GIVEN a successful operation with a broken telemetry hook
    // WHEN the hook tries to shape its settlement
    const answer = await observed([recording.observer], operation, () => OkAsync("committed"), {
      ok: () => {
        // oxlint-disable-next-line unthrown/no-throw -- a broken telemetry hook is the subject under test
        throw new Error("hook failed");
      },
    });

    // THEN the normal settlement and operation result survive
    expect({ answer, settled: recording.seen }).toEqual({
      answer: expect.objectContaining({ tag: "Ok", value: "committed" }),
      settled: [{ outcome: "ok" }],
    });
  });

  it("preserves a refusal when its settlement hook throws", async ({ recording }) => {
    // GIVEN a refused operation with a broken telemetry hook
    // WHEN the hook tries to shape its settlement
    const answer = await observed([recording.observer], operation, () => ErrAsync("refused"), {
      failure: () => {
        // oxlint-disable-next-line unthrown/no-throw -- a broken telemetry hook is the subject under test
        throw new Error("hook failed");
      },
    });

    // THEN the normal settlement carries the original refusal
    expect({ answer, settled: recording.seen }).toEqual({
      answer: expect.objectContaining({ tag: "Err", error: "refused" }),
      settled: [{ outcome: "error", cause: "refused" }],
    });
  });

  it("answers the success value untouched", async ({ recording }) => {
    // GIVEN a call that succeeds
    // WHEN it is observed
    const answer = observed([recording.observer], operation, () => OkAsync("hit"));

    // THEN the caller gets exactly what the call answered
    await expect(answer).toBeOkWith("hit");
  });

  it("settles a plain ok on the success channel", async ({ recording }) => {
    // GIVEN a call that succeeds
    // WHEN it is observed
    await observed([recording.observer], operation, () => OkAsync("hit"));

    // THEN the observer saw one plain ok
    expect(recording.seen).toEqual([{ outcome: "ok" }]);
  });

  it("answers the Err untouched", async ({ recording }) => {
    // GIVEN a call that fails on the Err channel
    // WHEN it is observed
    const answer = observed([recording.observer], operation, () => ErrAsync("down"));

    // THEN the caller gets exactly the Err the call answered
    await expect(answer).toBeErrWith("down");
  });

  it("settles error with the Err as cause", async ({ recording }) => {
    // GIVEN a call that fails on the Err channel
    // WHEN it is observed
    await observed([recording.observer], operation, () => ErrAsync("down"));

    // THEN the observer saw the error carrying the Err
    expect(recording.seen).toEqual([{ outcome: "error", cause: "down" }]);
  });

  it("settles error with the defect as cause, so a throw is a failed call too", async ({
    recording,
  }) => {
    // GIVEN a call whose AsyncResult defects
    const boom = new Error("boom");
    const defecting = (): AsyncResult<string, never> =>
      OkAsync().map((): string => {
        // oxlint-disable-next-line unthrown/no-throw -- the defect is the subject under test
        throw boom;
      });

    // WHEN it is observed
    await observed([recording.observer], operation, defecting);

    // THEN the observer saw the error carrying the thrown cause
    expect(recording.seen).toEqual([{ outcome: "error", cause: boom }]);
  });

  it("lets the caller shape the ok settlement from the value", async ({ recording }) => {
    // GIVEN an `ok` hook reading a dimension off the value
    // WHEN a miss is observed
    await observed([recording.observer], operation, () => OkAsync(undefined), {
      ok: (hit) => ({ outcome: "ok", attributes: { result: hit === undefined ? "miss" : "hit" } }),
    });

    // THEN the observer saw the hook's settlement rather than the default
    expect(recording.seen).toEqual([{ outcome: "ok", attributes: { result: "miss" } }]);
  });

  it("lets the caller shape the failure settlement from the failure view", async ({
    recording,
  }) => {
    // GIVEN a `failure` hook reading an ordinary answer as ok
    // WHEN a modeled not-found is observed
    await observed([recording.observer], operation, () => ErrAsync({ _tag: "NotFound" }), {
      failure: (failure) => ({
        outcome: failure.tag === "Err" && failure.error._tag === "NotFound" ? "ok" : "error",
      }),
    });

    // THEN the observer saw the hook's settlement rather than the default
    expect(recording.seen).toEqual([{ outcome: "ok" }]);
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
