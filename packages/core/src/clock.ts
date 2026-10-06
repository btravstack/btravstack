import { setTimeout } from "node:timers/promises";

import { fromSafePromise, type AsyncResult } from "unthrown";

export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => AsyncResult<void, never>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    // `ref: false` because the kernel's sleeps happen during shutdown, and an
    // outstanding timer must not keep the event loop alive. An abort rejects,
    // and an aborted sleep is simply over.
    fromSafePromise(setTimeout(ms, undefined, { signal, ref: false }).catch(() => {})),
};
