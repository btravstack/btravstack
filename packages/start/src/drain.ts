import { allAsync, fromSafePromise, type AsyncResult } from "unthrown";

import type { Clock } from "./clock.js";
import type { Serving } from "./runtime.js";
import type { UnitRegistry } from "./units.js";

export type DrainReport = {
  /** Units in flight when the drain began. */
  readonly inFlightAtStart: number;
  /**
   * Units that closed during the drain. Counted from a monotonic total, not
   * `inFlightAtStart - abandoned` — it may exceed `inFlightAtStart` if
   * in-flight work spawned more units during the drain. That is honest
   * reporting, not a bug: the alternative formula can go negative.
   */
  readonly completed: number;
  /** Units still open at the deadline. The exit-code decision reads this. */
  readonly abandoned: number;
};

export type DrainArgs = {
  // `Serving<unknown>`, not `Serving`: the drain reads only `drain`/`stop`, and
  // `info` is covariant, so this accepts a runtime publishing anything at all.
  readonly serving: Serving<unknown>;
  readonly registry: UnitRegistry;
  readonly clock: Clock;
  readonly preDrainDelayMs: number;
  readonly drainTimeoutMs: number;
  readonly skip: AbortSignal;
  // One-way: readiness only ever goes false, so this takes no argument. A
  // `(ready: boolean)` callback would carry a `true` case nothing can reach.
  readonly onUnready: () => void;
};

// The three beats, in order — the order is the whole point:
// 1. Readiness flips false, and `inFlightAtStart`/`closedAtStart` are sampled,
//    synchronously, before anything else. Sampling here — not after the
//    pre-drain delay — is what keeps `inFlightAtStart` honest against a unit
//    that starts or closes *during* the delay, and keeps it numerically
//    consistent with a `"draining"` event a caller emits from the same
//    synchronous turn (see `start.ts`'s `runDrain`).
// 2. `preDrainDelayMs` is waited out *before* the runtime is told to stop
//    accepting. Kubernetes endpoint removal is eventually consistent, so a
//    pod that stops accepting the instant it is asked to will still have
//    live traffic routed to it for a window after step 1 — this delay is
//    what closes that window, not a pointless sleep.
// 3. In-flight work gets `drainTimeoutMs` to finish; whatever is still open
//    at the deadline is aborted and reported abandoned. The timeout races
//    against the runtime having stopped *and* the registry going idle —
//    never awaited on its own — so a runtime that (correctly) treats
//    `signal` as its own cue to return can't deadlock this past the
//    deadline; `deadline` is aborted the instant the race settles, on
//    either branch, so such a runtime is always released.
//
// Every `Result` the three awaited calls hand back is threaded, never dropped.
// All three are typed `AsyncResult<void, never>`, and `never` empties the
// *error* channel only — a `Defect` can still be present at runtime. `Serving`
// is implemented by third-party runtimes, so a `drain` that throws internally
// arrives here as a Defect, and discarding it would report a clean shutdown
// that never happened.
export const drainApp = (args: DrainArgs): AsyncResult<DrainReport, never> => {
  args.onUnready();

  const inFlightAtStart = args.registry.inFlight();
  const closedAtStart = args.registry.closed();

  const deadline = new AbortController();

  return args.clock.sleep(args.preDrainDelayMs, args.skip).flatMap(() => {
    const drainStopped = args.serving.drain(deadline.signal);

    // An `AsyncResult` is a thenable, so racing the two branches yields
    // whichever `Result` settles first — inspected below rather than dropped.
    // `allAsync` is the pair's `Promise.all`, with a Defect from either side
    // dominating.
    return fromSafePromise(
      Promise.race([
        allAsync([drainStopped, args.registry.awaitIdle()]).discard(),
        args.clock.sleep(args.drainTimeoutMs, args.skip),
      ]),
    ).flatMap((raced) => {
      // Aborted the instant the race settles, on either branch and whatever the
      // winning `Result` carries — a runtime that treats `signal` as its cue to
      // return is released on the defect path too. Sampling the counters stays
      // in this same synchronous continuation, as it was when the whole tail
      // followed a single `await`.
      deadline.abort();

      return raced.map(() => {
        const abandoned = args.registry.inFlight();
        if (abandoned > 0) {
          args.registry.abortAll();
        }

        // Monotonic, not `inFlightAtStart - abandoned`: that formula goes
        // negative the moment a unit starts after `inFlightAtStart` was
        // sampled and then closes before the deadline (see `DrainReport` above).
        return { inFlightAtStart, completed: args.registry.closed() - closedAtStart, abandoned };
      });
    });
  });
};
