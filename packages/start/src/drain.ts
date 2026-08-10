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
// 1. Readiness flips false, synchronously, before anything else.
// 2. `preDrainDelayMs` is waited out *before* the runtime is told to stop
//    accepting. Kubernetes endpoint removal is eventually consistent, so a
//    pod that stops accepting the instant it is asked to will still have
//    live traffic routed to it for a window after step 1 — this delay is
//    what closes that window, not a pointless sleep.
// 3. In-flight work gets `drainTimeoutMs` to finish; whatever is still open
//    at the deadline is aborted and reported abandoned.
export const drainApp = (args: DrainArgs): AsyncResult<DrainReport, never> => {
  args.onReadyChange(false);

  const deadline = new AbortController();

  return fromSafePromise(
    (async (): Promise<DrainReport> => {
      await args.clock.sleep(args.preDrainDelayMs, args.skip);

      const inFlightAtStart = args.registry.inFlight();
      await args.serving.drain(deadline.signal);

      await Promise.race([
        args.registry.awaitIdle(),
        args.clock.sleep(args.drainTimeoutMs, args.skip),
      ]);

      const abandoned = args.registry.inFlight();
      if (abandoned > 0) {
        deadline.abort();
        args.registry.abortAll();
      }

      return { inFlightAtStart, completed: inFlightAtStart - abandoned, abandoned };
    })(),
  );
};
