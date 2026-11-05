// "A shared diagnostic disclosure policy" — docs/reference/observability.md.
// Local imports exercise the same entry points the published examples use.
import { Logger, Meter, Tracer, type DiagnosticPolicy, type LoggerService } from "@btravstack/core";
import { Module } from "@btravstack/di";
import pino from "pino";
import { expectTypeOf } from "vitest";

import {
  createLogger,
  diagnosticPolicy,
  jsonSink,
  kernelEvents,
  observability,
  sensitiveDiagnostics,
  type DiagnosticField,
  type DiagnosticOptions,
  type ObservabilityOptions,
  type Sink,
} from "./index.js";
import { otel, type OtelOptions } from "./otel.js";
import { pinoSink } from "./pino.js";

const operationalFields = {
  method: ["GET", "POST"],
  status: { min: 100, max: 599 },
  retryable: [true, false],
} satisfies Readonly<Record<string, DiagnosticField>>;
const disclosure: DiagnosticOptions = {
  messages: ["http.request", "http.request failed"],
  codes: ["DatabaseUnavailable"],
  fields: operationalFields,
};
const production = diagnosticPolicy(disclosure);
const productionSink = jsonSink(process.stdout, production);
const productionOptions = {
  diagnostics: production,
  level: "info",
  sink: productionSink,
} satisfies ObservabilityOptions;
const telemetryOptions = {
  diagnostics: production,
  spanProcessors: [],
} satisfies OtelOptions;

const infrastructure = Module("DiagnosticInfrastructure")({
  imports: [observability(productionOptions), otel(telemetryOptions)],
  exports: [Logger, Tracer, Meter],
});
const startupLogger = createLogger(jsonSink(), "info", production);
const onEvent = kernelEvents(startupLogger);
const startupOptions = { onEvent } satisfies import("@btravstack/core").StartOptions;
const indexedLogger = createLogger(
  pinoSink(pino({ level: "trace" }), production),
  "info",
  production,
);

expectTypeOf(production).toEqualTypeOf<DiagnosticPolicy>();
expectTypeOf(productionSink).toEqualTypeOf<Sink>();
expectTypeOf(startupLogger).toEqualTypeOf<LoggerService>();
expectTypeOf(indexedLogger).toEqualTypeOf<LoggerService>();
void infrastructure;
void startupOptions;

// Sensitive debugging requires a separately authorized destination.
declare const restrictedDebugStream: { readonly write: (chunk: string) => void };
const debugOptions = {
  diagnostics: sensitiveDiagnostics,
  level: "debug",
  sink: jsonSink(restrictedDebugStream, sensitiveDiagnostics),
} satisfies ObservabilityOptions;
const debugLogger = createLogger(debugOptions.sink, debugOptions.level, debugOptions.diagnostics);
const debugIndexedSink = pinoSink(pino(restrictedDebugStream), sensitiveDiagnostics);
const debugLogging = observability(debugOptions);
const debugTracing = otel({ diagnostics: sensitiveDiagnostics, spanProcessors: [] });

expectTypeOf(sensitiveDiagnostics).toEqualTypeOf<DiagnosticPolicy>();
expectTypeOf(debugLogger).toEqualTypeOf<LoggerService>();
expectTypeOf(debugIndexedSink).toEqualTypeOf<Sink>();
void debugLogging;
void debugTracing;
