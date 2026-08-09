export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      // The kernel's sleeps happen during shutdown; an outstanding timer must
      // not be the reason the event loop stays alive.
      timer.unref?.();

      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
