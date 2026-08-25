import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { createDeferred } from "./deferred.js";
import { releasedBy } from "./runtime.js";

describe("releasedBy", () => {
  it("waits for the work when the work settles first", async () => {
    // GIVEN work that will finish, and a deadline that never fires
    const deadline = new AbortController();
    const work = createDeferred<void>();
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
