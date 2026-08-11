const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export type SignalHandlers = {
  readonly onFirst: () => void;
  readonly onSecond: () => void;
};

export const installSignalHandlers = (handlers: SignalHandlers): (() => void) => {
  let seen = 0;

  const onSignal = (): void => {
    seen += 1;
    if (seen === 1) {
      handlers.onFirst();
      return;
    }
    handlers.onSecond();
  };

  for (const signal of SIGNALS) process.on(signal, onSignal);

  return () => {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
};

// Only the first uncaught exception or unhandled rejection is reported: the
// shutdown it triggers may itself produce further noise, and the exit report
// names one cause (see `start.ts`'s `"uncaught"` wiring).
export const installUncaughtHandlers = (onUncaught: (cause: unknown) => void): (() => void) => {
  let reported = false;

  const report = (cause: unknown): void => {
    if (reported) return;
    reported = true;
    onUncaught(cause);
  };

  const onException = (error: Error): void => report(error);
  const onRejection = (reason: unknown): void => report(reason);

  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
};
