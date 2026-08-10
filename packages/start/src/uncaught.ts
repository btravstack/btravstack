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
