import { fromSafePromise, type AsyncResult } from "unthrown";

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

// The three beats, in order — root CLAUDE.md's thesis 5 says why each exists.
// Three orderings here are load-bearing and are what the comments below guard:
// the counters are sampled BEFORE the pre-drain sleep, `awaitIdle()` is
// sequenced AFTER the runtime's `drain` rather than alongside it, and the
// deadline is aborted the instant the race settles on either branch.
//
// Every `Result` the three awaited calls hand back is threaded, never dropped.
// `AsyncResult<void, never>` empties the *error* channel only — a `Serving`
// written by a third party can still defect, and discarding it would report a
// clean shutdown that never happened.
export const drainApp = (args: DrainArgs): AsyncResult<DrainReport, never> => {
  args.onUnready();

  const inFlightAtStart = args.registry.inFlight();
  const closedAtStart = args.registry.closed();

  const deadline = new AbortController();

  return args.clock.sleep(args.preDrainDelayMs, args.skip).flatMap(() => {
    const drainStopped = args.serving.drain(deadline.signal);

    // `awaitIdle()` is SEQUENCED behind `drainStopped`, never sampled alongside
    // it: it answers about the registry at the instant it is called, so a unit
    // opening while `drain` is still resolving would go unwaited and be
    // reported abandoned with the whole budget unspent. The losing branch's
    // `Result` is the one drop here — once the timeout has decided the report,
    // `exited` has settled and a late defect has no consumer.
    return fromSafePromise(
      Promise.race([
        drainStopped.flatMap(() => args.registry.awaitIdle()),
        args.clock.sleep(args.drainTimeoutMs, args.skip),
      ]),
    ).flatMap((raced) => {
      // On either branch, and whatever the winning `Result` carries: a runtime
      // that treats `signal` as its cue to return is released on the defect
      // path too.
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
