import type { DiagnosticPolicy, LoggerService, Level } from "@btravstack/core";
import type { Logger, LogLevel } from "@temporalio/common";
import { IllegalStateError } from "@temporalio/common";
import { Runtime } from "@temporalio/worker";
import { OkAsync, fromSafeThrowable, type AsyncResult, type Result } from "unthrown";

const levels: Readonly<Record<LogLevel, Level>> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

let reservation: Parameters<typeof Runtime.install>[0] | undefined;

/** The shared policy and destination for Temporal SDK and native diagnostics. */
export type TemporalDiagnosticsOptions = {
  readonly logger: LoggerService;
  readonly diagnostics: DiagnosticPolicy;
  /** Native Core verbosity before the shared logger's severity filter. Default: WARN. */
  readonly nativeLogLevel?: LogLevel;
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
 * Configure Temporal's next native Runtime without creating it. Invoke startup
 * inside the callback and keep owned connections and workers within its lifetime.
 * Restores the previous defaults on every outcome without closing an active
 * Runtime or overwriting a replacement configuration. Existing runtimes and
 * overlapping scopes defect. The callback must not call Runtime.install itself;
 * that explicit SDK configuration overrides these defaults.
 */
export const withTemporalDiagnostics = <T, E>(
  options: TemporalDiagnosticsOptions,
  work: () => Result<T, E> | AsyncResult<T, E>,
): AsyncResult<T, E> =>
  reserveDiagnostics(options)
    .toAsync()
    .flatMap((release) => OkAsync().flatMap(work).tap(release).tapFailure(release));

/**
 * Install once, before the first Temporal connection or worker in this process.
 * Routes TypeScript SDK, workflow, activity and native Core logs through one
 * policy. A late installation defects rather than retaining an unprotected runtime.
 * This eagerly creates a native Runtime; it cannot release an idle Runtime when
 * startup fails before a connection. Prefer withTemporalDiagnostics for startup.
 * Native log buffering and shutdown remain owned by Temporal's Runtime.
 */
export const installTemporalDiagnostics = (
  options: TemporalDiagnosticsOptions,
): Result<void, never> =>
  fromSafeThrowable(() => {
    if (reservation !== undefined) {
      // oxlint-disable-next-line unthrown/no-throw -- overlapping process-wide configuration is a programming defect
      throw new IllegalStateError("Temporal diagnostics are already scoped");
    }
    Runtime.install(runtimeOptions(options));
  })();

const reserveDiagnostics = (options: TemporalDiagnosticsOptions): Result<() => void, never> =>
  fromSafeThrowable(() => {
    if (reservation !== undefined || Runtime._instance !== undefined) {
      // oxlint-disable-next-line unthrown/no-throw -- replacing an active runtime or overlapping scope would break process-wide disclosure policy
      throw new IllegalStateError(
        "Temporal diagnostics require an uninitialized, unreserved Runtime",
      );
    }
    const previous = Runtime.defaultOptions;
    const configured = runtimeOptions(options);
    Runtime.defaultOptions = configured;
    reservation = configured;
    return () => {
      if (Runtime.defaultOptions === configured) Runtime.defaultOptions = previous;
      if (reservation === configured) reservation = undefined;
    };
  })();

const runtimeOptions = (
  options: TemporalDiagnosticsOptions,
): Parameters<typeof Runtime.install>[0] => ({
  logger: temporalDiagnosticLogger(options.logger, options.diagnostics),
  shutdownSignals: [],
  telemetryOptions: {
    logging: { forward: {}, filter: { core: options.nativeLogLevel ?? "WARN", other: "WARN" } },
  },
});
