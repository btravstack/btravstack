import { fromSafePromise, type AsyncResult } from "unthrown";

import type { Clock } from "./clock.js";
import type { Serving } from "./runtime.js";
import type { UnitRegistry } from "./units.js";

export type DrainReport = {
  /** Units in flight when the drain began. */
  readonly inFlightAtStart: number;
  /**
   * Units that closed during the drain, counted from a monotonic total. It may
   * exceed `inFlightAtStart` when in-flight work spawned more units — honest
   * reporting, where `inFlightAtStart - abandoned` can go negative.
   */
  readonly completed: number;
  /**
   * Units still open at the deadline. The exit-code decision reads this.
   *
   * **It means "no longer AWAITED", not "did not finish".** The kernel stops
   * waiting and aborts each unit's signal; it cannot cancel work, and the
   * transport underneath keeps running on its own clock. An abandoned AMQP
   * delivery usually goes on to be acked, and an abandoned Temporal activity
   * goes on to complete — after this report said they did not.
   *
   * **The consequence, stated because nothing else states it: the process may
   * not end by itself.** `runMain` sets an exit code and deliberately never
   * calls `process.exit()`, so the process ends when the event loop empties —
   * and a transport still winding down is holding it open. Nothing here
   * terminates it.
   *
   * Under a Kubernetes-initiated shutdown that ends at
   * `terminationGracePeriodSeconds`, with SIGKILL, so exit `2` is what the
   * report SAYS rather than what the orchestrator observes. Outside that
   * lifecycle there is no SIGKILL: the process simply stays alive until the
   * transport is done. `kubectl logs --previous` carries the report either
   * way, which is what it is for.
   */
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

// Three orderings here are load-bearing: the counters are sampled BEFORE the
// pre-drain sleep, `awaitIdle()` is sequenced AFTER the runtime's `drain`, and
// the deadline is aborted the instant the race settles on either branch.
//
// Every `Result` the awaited calls hand back is threaded, never dropped.
// `AsyncResult<void, never>` empties the error channel only, and a third-party
// `Serving` can still defect.
export const drainApp = (args: DrainArgs): AsyncResult<DrainReport, never> => {
  args.onUnready();

  const inFlightAtStart = args.registry.inFlight();
  const closedAtStart = args.registry.closed();

  const deadline = new AbortController();

  return args.clock.sleep(args.preDrainDelayMs, args.skip).flatMap(() => {
    const drainStopped = args.serving.drain(deadline.signal);

    // SEQUENCED behind `drainStopped`, never sampled alongside it: `awaitIdle`
    // answers about the registry at the instant it is called, so a unit opening
    // while `drain` is still resolving would go unwaited and be reported
    // abandoned with the whole budget unspent. The losing branch's `Result` is
    // the one drop here — the report is already decided.
    return fromSafePromise(
      Promise.race([
        drainStopped.flatMap(() => args.registry.awaitIdle()),
        args.clock.sleep(args.drainTimeoutMs, args.skip),
      ]),
    ).flatMap((raced) => {
      // On either branch, whatever the winning `Result` carries: a runtime that
      // treats `signal` as its cue to return is released on the defect path too.
      deadline.abort();

      return raced.map(() => {
        const abandoned = args.registry.inFlight();
        if (abandoned > 0) {
          args.registry.abortAll();
        }

        // Monotonic, never `inFlightAtStart - abandoned`, which goes negative
        // once a unit starts after the sample and closes before the deadline.
        return { inFlightAtStart, completed: args.registry.closed() - closedAtStart, abandoned };
      });
    });
  });
};
