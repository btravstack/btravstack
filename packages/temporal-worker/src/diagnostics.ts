import type { DiagnosticPolicy, LoggerService, Level } from "@btravstack/core";
import type { Logger, LogLevel } from "@temporalio/common";
import { Runtime } from "@temporalio/worker";
import { fromSafeThrowable, type Result } from "unthrown";

const levels: Readonly<Record<LogLevel, Level>> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

/** A Temporal SDK logger applying the shared policy before any destination. */
export const temporalDiagnosticLogger = (
  logger: LoggerService,
  diagnostics: DiagnosticPolicy,
): Logger => {
  const log = (
    level: LogLevel,
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): void => {
    logger[levels[level]](diagnostics.message(message), diagnostics.attributes(metadata ?? {}));
  };
  return {
    log,
    trace: (message, metadata) => log("TRACE", message, metadata),
    debug: (message, metadata) => log("DEBUG", message, metadata),
    info: (message, metadata) => log("INFO", message, metadata),
    warn: (message, metadata) => log("WARN", message, metadata),
    error: (message, metadata) => log("ERROR", message, metadata),
  };
};

/**
 * Install once, before the first Temporal connection or worker in this process.
 * Routes TypeScript SDK, workflow, activity and native Core logs through one
 * policy. A late installation defects rather than retaining an unprotected runtime.
 * Native log buffering and shutdown remain owned by Temporal's Runtime.
 */
export const installTemporalDiagnostics = (options: {
  readonly logger: LoggerService;
  readonly diagnostics: DiagnosticPolicy;
  /** Native Core verbosity before the shared logger's severity filter. Default: WARN. */
  readonly nativeLogLevel?: LogLevel;
}): Result<void, never> =>
  fromSafeThrowable(() => {
    Runtime.install({
      logger: temporalDiagnosticLogger(options.logger, options.diagnostics),
      shutdownSignals: [],
      telemetryOptions: {
        logging: { forward: {}, filter: { core: options.nativeLogLevel ?? "WARN", other: "WARN" } },
      },
    });
  })();
