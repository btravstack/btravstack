import { fromSafePromise, type AsyncResult } from "unthrown";

import type { Clock } from "./clock.js";

type Sleeper = {
  readonly due: number;
  readonly resolve: () => void;
};

export type FakeClock = Clock & {
  /**
   * Move the clock forward, resolving every sleep whose deadline has passed.
   *
   * The returned `AsyncResult` settles once the code under test has had a
   * chance to react — so `await clock.advance(5_000)` leaves the application
   * where the elapsed time takes it, with no extra flushing at the call site.
   */
  readonly advance: (ms: number) => AsyncResult<void, never>;
};

// A real macrotask boundary — the only real timing this clock uses. Every
// microtask already queued, and every microtask those queue in turn, runs
// before it resolves. `advance` brackets itself with one at each end so a test
// can trigger a shutdown and advance in the very next statement without racing
// the kernel's arming of its next sleep.
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A {@link Clock} whose time only moves when a test says so.
 *
 * Pass it as `StartOptions.clock` to drive the drain's pre-drain delay and
 * deadline explicitly, instead of waiting out the real 5s/20s defaults.
 *
 * @example
 * ```ts
 * const clock = createFakeClock();
 * const app = start(AppModule, { runtime, clock });
 *
 * app.requestDrain();
 * await clock.advance(5_000); // the pre-drain delay
 * await clock.advance(20_000); // the drain deadline
 * ```
 */
export const createFakeClock = (start = 0): FakeClock => {
  let now = start;
  let sleepers: readonly Sleeper[] = [];

  return {
    now: () => now,
    sleep: (ms, signal) =>
      fromSafePromise(
        new Promise<void>((resolve) => {
          if (ms <= 0 || signal?.aborted === true) {
            resolve();
            return;
          }

          const sleeper: Sleeper = { due: now + ms, resolve };
          sleepers = [...sleepers, sleeper];

          // The kernel's `skip` signal (a second SIGTERM) cuts the current wait
          // short; a fake clock that ignored it would hang that path forever.
          signal?.addEventListener(
            "abort",
            () => {
              sleepers = sleepers.filter((pending) => pending !== sleeper);
              resolve();
            },
            { once: true },
          );
        }),
      ),
    advance: (ms) =>
      fromSafePromise(
        (async () => {
          await flush();

          now += ms;
          const due = sleepers.filter((sleeper) => sleeper.due <= now);
          sleepers = sleepers.filter((sleeper) => sleeper.due > now);
          for (const sleeper of due) sleeper.resolve();

          await flush();
        })(),
      ),
  };
};
