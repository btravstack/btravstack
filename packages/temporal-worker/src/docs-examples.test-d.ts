// "Diagnostic disclosure" — docs/reference/temporal-worker.md.
import type { DiagnosticPolicy } from "@btravstack/core";
import {
  createLogger,
  diagnosticPolicy,
  jsonSink,
  sensitiveDiagnostics,
} from "@btravstack/observability";
import type { Logger as TemporalLogger } from "@temporalio/common";
import { Runtime } from "@temporalio/worker";
import type { Result } from "unthrown";
import { expectTypeOf } from "vitest";

import { installTemporalDiagnostics, temporalDiagnosticLogger } from "./index.js";

const production: DiagnosticPolicy = diagnosticPolicy({
  messages: ["worker.unavailable"],
  codes: ["DatabaseUnavailable"],
  fields: { sdkComponent: ["activity", "workflow", "worker", "core"] },
});
const logger = createLogger(jsonSink(), "info", production);
// These compile-only startup examples are mutually exclusive: install once.
const installProduction = () => installTemporalDiagnostics({ logger, diagnostics: production });
const installProductionAtWarn = () =>
  installTemporalDiagnostics({
    logger,
    diagnostics: production,
    nativeLogLevel: "WARN",
  });

expectTypeOf<ReturnType<typeof installProduction>>().toEqualTypeOf<Result<void, never>>();
expectTypeOf<ReturnType<typeof installProductionAtWarn>>().toEqualTypeOf<Result<void, never>>();

// An application owning Runtime.install still forwards the native log channel.
const sdkLogger = temporalDiagnosticLogger(logger, production);
const runtimeOptions = {
  logger: sdkLogger,
  shutdownSignals: [],
  telemetryOptions: { logging: { forward: {}, filter: { core: "WARN", other: "WARN" } } },
} satisfies Parameters<typeof Runtime.install>[0];
expectTypeOf(sdkLogger).toEqualTypeOf<TemporalLogger>();
void runtimeOptions;

declare const restrictedDebugStream: { readonly write: (chunk: string) => void };
const debugLogger = createLogger(jsonSink(restrictedDebugStream), "debug", sensitiveDiagnostics);
const debugSdkLogger = temporalDiagnosticLogger(debugLogger, sensitiveDiagnostics);
const installSensitiveDebug = () =>
  installTemporalDiagnostics({
    logger: debugLogger,
    diagnostics: sensitiveDiagnostics,
    nativeLogLevel: "DEBUG",
  });

expectTypeOf(debugSdkLogger).toEqualTypeOf<TemporalLogger>();
expectTypeOf<ReturnType<typeof installSensitiveDebug>>().toEqualTypeOf<Result<void, never>>();
