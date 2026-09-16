import type { Logger, LoggerContext } from "@amqp-contract/worker";
import { observe, type Operation, type Settle } from "@btravstack/core";

/**
 * The library's own diagnostics, as operations on `Observers`.
 *
 * **`@amqp-contract/worker` takes a `logger` and was given none**, so every
 * line it writes was discarded: "Consumer cancelled by server", "poison message
 * will be lost on nack", "Max retries exceeded, sending to DLQ", "Publish for
 * retry failed; leaving original un-ack'd", "Failed to parse/validate message;
 * sending to DLQ", and the channel's own `error`. Each of those is a fact an
 * operator has no other way to learn: the first three are permanent outages
 * this package's own `Serving` cannot see, and the last is where a poison
 * stream goes — nacked before the handler middleware runs, so the `outcome`
 * dimension a healthy-looking rate is read off never sees it.
 *
 * **Observers rather than the kernel's `Logger` port.** Forwarding `Logger`
 * would put it in `amqp()`'s `Needs`, which is exactly the compile error the
 * `instrumented` flag was deleted for: a root that wants a worker and no
 * OpenTelemetry SDK should not be handed a port list. This costs a root
 * nothing — the starter already injects `Observers` and contributes the no-op
 * member — and a root composing `observability()` gets the lines for free.
 *
 * **`debug` and `info` are dropped, and that is the shape of the seam rather
 * than a judgement about them.** An observer writes no line for a successful
 * operation — the repository's own rule, and what keeps a per-request metric
 * from also being a per-request line — so an `info` mapped to `outcome: "ok"`
 * would be silently discarded anyway. Every diagnostic the issue named is a
 * `warn` or an `error`, which is the half that survives.
 *
 * `traced: false`: these have no duration, and a zero-length span per broker
 * line is noise in a trace rather than information.
 */
export const brokerLog = (observers: readonly ((operation: Operation) => Settle)[]): Logger => {
  const report =
    (level: "warn" | "error") =>
    (message: string, context?: LoggerContext): void => {
      const settle = observe(observers, {
        component: "amqp",
        name: "broker",
        // `level` is the bounded half — two values — and safe on an instrument.
        // The MESSAGE is the library's own literal, but a future one could
        // interpolate a queue or a routing key, so it rides `details` where one
        // more value costs one more field rather than a time series.
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
