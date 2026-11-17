import type { Logger, LoggerContext } from "@amqp-contract/client";
import { observe, type Operation, type Settle } from "@btravstack/core";

/**
 * The library's own diagnostics, as operations on `Observers`: a failed
 * connection attempt, a channel error, a dropped RPC reply. `debug` and `info`
 * are dropped, since an observer writes no line for a successful operation.
 * `traced: false`: a broker line has no duration.
 */
export const brokerLog = (observers: readonly ((operation: Operation) => Settle)[]): Logger => {
  const report =
    (level: "warn" | "error") =>
    (message: string, context?: LoggerContext): void => {
      const settle = observe(observers, {
        component: "amqp-client",
        name: "broker",
        attributes: { level },
        details: { message },
        traced: false,
      });
      settle({
        outcome: "error",
        attributes: {},
        ...(context?.error === undefined ? {} : { cause: context.error }),
      });
    };

  const ignore = (): void => {};
  return { debug: ignore, info: ignore, warn: report("warn"), error: report("error") };
};
