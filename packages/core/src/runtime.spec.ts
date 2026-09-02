import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { releasedBy, traceIdOfTraceparent } from "./runtime.js";

describe("releasedBy", () => {
  it("waits for the work when the work settles first", async () => {
    // GIVEN work that will finish, and a deadline that never fires
    const deadline = new AbortController();
    const work = Promise.withResolvers<void>();
    let finished = false;
    const running = fromSafePromise(
      work.promise.then(() => {
        finished = true;
      }),
    );

    // WHEN the work settles before the deadline
    const released = releasedBy(deadline.signal, running);
    work.resolve();
    const result = await released;

    // THEN it waited rather than cutting the work short
    expect({ ok: result.isOk(), finished, aborted: deadline.signal.aborted }).toEqual({
      ok: true,
      finished: true,
      aborted: false,
    });
  });

  it("releases on the deadline when the work is still outstanding", async () => {
    // GIVEN work that never settles
    const deadline = new AbortController();
    let finished = false;
    const running = fromSafePromise(
      new Promise<void>(() => {}).then(() => {
        finished = true;
      }),
    );

    // WHEN the deadline fires
    const released = releasedBy(deadline.signal, running);
    deadline.abort();
    const result = await released;

    // THEN the caller is released with the work still outstanding
    expect({ ok: result.isOk(), finished }).toEqual({ ok: true, finished: false });
  });

  it("releases immediately when the deadline has already passed", async () => {
    // GIVEN a signal aborted before the race begins, and work that never settles
    let finished = false;
    const running = fromSafePromise(
      new Promise<void>(() => {}).then(() => {
        finished = true;
      }),
    );

    // WHEN it is raced against that signal
    const result = await releasedBy(AbortSignal.abort(), running);

    // THEN it releases without waiting on a listener that would never fire
    expect({ ok: result.isOk(), finished }).toEqual({ ok: true, finished: false });
  });
});

describe("traceIdOfTraceparent", () => {
  it("takes the trace-id field and drops the parent's span id", () => {
    // GIVEN a well-formed W3C traceparent
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    // WHEN it is read
    const traceId = traceIdOfTraceparent(header);

    // THEN what comes back is the trace id alone: a correlation id, never a
    // span context half-carried
    expect(traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("refuses every header the specification calls invalid", () => {
    // GIVEN the ways a header fails to name a usable trace: malformed,
    // truncated, an all-zero trace id, an all-zero PARENT id (well-formed, and
    // naming no span), and the reserved version `ff`
    const refused = {
      malformed: traceIdOfTraceparent("not-a-traceparent"),
      truncated: traceIdOfTraceparent("00-4bf92f3577b34da6-00f067aa0ba902b7-01"),
      allZeroTrace: traceIdOfTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
      allZeroParent: traceIdOfTraceparent(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      ),
      reservedVersion: traceIdOfTraceparent(
        "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      ),
    };

    // WHEN each is read
    // THEN each answers undefined, leaving the runtime's own fallback id to
    // run — adopting one would replace a usable id with a meaningless one
    expect(refused).toEqual({
      malformed: undefined,
      truncated: undefined,
      allZeroTrace: undefined,
      allZeroParent: undefined,
      reservedVersion: undefined,
    });
  });

  it("tolerates the surrounding whitespace a header may arrive with", () => {
    // GIVEN a valid header padded the way a proxy may forward it
    const padded = "  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\t";

    // WHEN it is read
    const traceId = traceIdOfTraceparent(padded);

    // THEN the padding is not what makes a trace unreadable
    expect(traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});
