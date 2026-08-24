import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import {
  Logger,
  type EventSink,
  type KernelEvent,
  type Level,
  type LoggerService,
} from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";

import { loggerSchema, type LoggerSettings } from "./config.js";
import { jsonSink } from "./json-sink.js";
import { createLogger, type Sink } from "./logger.js";

/**
 * What the graph bound from the environment: the level every logger in it
 * filters at. A port of its own, like a starter's `HttpConfig`, so anything
 * that wants to know reads it rather than re-deriving it.
 */
export class LoggerConfig extends Port("LoggerConfig")<LoggerSettings> {}

export type ObservabilityOptions = {
  /**
   * Where lines go. Default: one JSON object per line on `stdout` —
   * dependency-free, and the shape every log backend already reads. The
   * `@btravstack/observability/pino` subpath is the same seam for a
   * deployment that wants pino's throughput.
   */
  readonly sink?: Sink;
  /** Pins the level instead of reading `LOG_LEVEL` — a test's `"fatal"`, a CLI's `"debug"`. */
  readonly level?: Level;
};

/**
 * The observability starter: a module providing the application's `Logger`
 * and the `LoggerConfig` it was built from.
 *
 * Import it next to the application and export `Logger` — that is the whole
 * of it. Every line carries the ambient unit's `traceId` because the logger
 * reads `currentUnit()` per call, so a request's lines are attributable
 * without a single argument threaded through the call stack, and without the
 * mutable per-instance context that makes that trick unsafe elsewhere.
 *
 * An application that wants its own implementation provides `Logger` itself
 * and does not import this module; one that wants this implementation with a
 * different destination passes a `sink`. Both are the same seam a starter
 * always offers: the default behaviour is here, and it is one argument to
 * replace.
 */
export const observability = (
  options: ObservabilityOptions = {},
): Module<Logger | LoggerConfig, ConfigInvalid, Env> =>
  Module("Observability")({
    // The starter reads `LOG_LEVEL`, so it owes `Env` — which no module here
    // provides and `start` supplies at the root. Declared, because a need
    // nothing local satisfies is this module's to state.
    needs: [Env],
    provides: [
      Config.provider(LoggerConfig)(loggerSchema(options.level)),
      Provider(Logger)(
        { config: LoggerConfig },
        {
          sync: ({ config }) => createLogger(options.sink ?? jsonSink(), config.level),
        },
      ),
    ],
    exports: [Logger, LoggerConfig],
  });

/**
 * The kernel's nine lifecycle events, as log lines on `logger`.
 *
 * `StartOptions.onEvent` takes a sink and the kernel's default writes JSON to
 * stderr, which is correct for a process with no logger and wrong for one
 * with: two streams, two shapes, two sets of fields to search. This is the
 * adapter between them — pass it as `onEvent` and `serving` lands next to the
 * request that was in flight when it did.
 *
 * The mapping is deliberate rather than mechanical. `startFailed` and
 * `uncaught` are `error`: they carry a cause and they are what an operator is
 * paged for. `teardownError` is `warn` — the application is already stopping
 * and the exit code says so — and everything else is `info`, one line per
 * transition. The event's own fields become attributes, so `draining` keeps
 * its `inFlight` count and `drained` its report.
 *
 * The logger is passed in rather than resolved: this runs before the graph
 * exists (`building` is emitted while it is still being built), so it cannot
 * come from the context it is watching.
 */
export const kernelEvents =
  (logger: LoggerService): EventSink =>
  (event: KernelEvent) => {
    switch (event.type) {
      case "startFailed":
        logger.error("the application failed to start", { event: event.type }, event.cause);
        return;
      case "uncaught":
        logger.error(
          "an uncaught exception stopped the application",
          { event: event.type },
          event.cause,
        );
        return;
      case "teardownError":
        logger.warn(
          "a finaliser failed while the application was stopping",
          { event: event.type, port: event.port },
          event.cause,
        );
        return;
      case "serving":
        logger.info("serving", { event: event.type, runtime: event.runtime });
        return;
      case "draining":
        logger.info("draining", { event: event.type, inFlight: event.inFlight });
        return;
      case "drained":
        logger.info("drained", {
          event: event.type,
          inFlightAtStart: event.report.inFlightAtStart,
          completed: event.report.completed,
          abandoned: event.report.abandoned,
        });
        return;
      default:
        logger.info(event.type, { event: event.type });
    }
  };
