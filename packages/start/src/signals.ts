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
