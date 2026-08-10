import { fromSafePromise, type AsyncResult } from "unthrown";

import type { Clock } from "./clock.js";
import type { DrainReport } from "./drain-report.js";
import type { Serving } from "./runtime.js";
import type { UnitRegistry } from "./units.js";

export type DrainArgs = {
  readonly serving: Serving;
  readonly registry: UnitRegistry;
  readonly clock: Clock;
  readonly preDrainDelayMs: number;
  readonly drainTimeoutMs: number;
  readonly skip: AbortSignal;
  readonly onReadyChange: (ready: boolean) => void;
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
export const drainApp = (args: DrainArgs): AsyncResult<DrainReport, never> => {
  args.onReadyChange(false);

  const inFlightAtStart = args.registry.inFlight();
  const closedAtStart = args.registry.closed();

  const deadline = new AbortController();

  return fromSafePromise(
    (async (): Promise<DrainReport> => {
      await args.clock.sleep(args.preDrainDelayMs, args.skip);

      const drainStopped = args.serving.drain(deadline.signal);

      await Promise.race([
        Promise.all([drainStopped, args.registry.awaitIdle()]),
        args.clock.sleep(args.drainTimeoutMs, args.skip),
      ]);

      deadline.abort();

      const abandoned = args.registry.inFlight();
      if (abandoned > 0) {
        args.registry.abortAll();
      }

      // Monotonic, not `inFlightAtStart - abandoned`: that formula goes
      // negative the moment a unit starts after `inFlightAtStart` was
      // sampled and then closes before the deadline (see `drain-report.ts`).
      return { inFlightAtStart, completed: args.registry.closed() - closedAtStart, abandoned };
    })(),
  );
};
