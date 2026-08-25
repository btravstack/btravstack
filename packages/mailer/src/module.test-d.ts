/**
 * The compile-time half of `instrumented`: the flag defaults to `true`, so a
 * root composing a mailer and no observability fails di's dependency gate naming
 * `Logger`, `Meter` and `Tracer` — never a quiet absence of spans. `false` is
 * the opt-out, and it owes nothing.
 */
import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OkAsync } from "unthrown";

import { Mailer } from "./mailer.js";
import { mailer } from "./module.js";
import { mailRecorder, recordingMailer } from "./recording.js";

// Positive: the default instruments, and with `observability()` and `otel()`
// beside it nothing is left owing.
const Instrumented = Module("Instrumented")({
  imports: [mailer({ adapter: recordingMailer(mailRecorder()) }), observability(), otel()],
  // `observability()` reads `LOG_LEVEL`, which `start` supplies in a real
  // application; here the root is this file.
  provides: [Provider(Env)({ value: {} })],
  exports: [Mailer],
});
const _instrumented = Module.scoped(Instrumented, (ctx) => OkAsync(ctx.get(Mailer)));

// The default, with the three ports nowhere in the graph.
const Unobserved = Module("Unobserved")({
  imports: [mailer({ adapter: recordingMailer(mailRecorder()) })],
  exports: [Mailer],
});

// Negative, and the reason the default is `true`: forgetting the observability
// modules is a compile error naming the ports, not a mailer that silently
// counts nothing.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides Logger, Meter or Tracer.
const _unobserved = Module.scoped(Unobserved, (ctx) => OkAsync(ctx.get(Mailer)));

// The opt-out needs nothing and installs nothing.
const Plain = Module("Plain")({
  imports: [mailer({ adapter: recordingMailer(mailRecorder()), instrumented: false })],
  exports: [Mailer],
});
const _plain = Module.scoped(Plain, (ctx) => OkAsync(ctx.get(Mailer)));

// Spelling the default out reaches the same arm as leaving it off.
const Explicit = Module("Explicit")({
  imports: [
    mailer({ adapter: recordingMailer(mailRecorder()), instrumented: true }),
    observability(),
    otel(),
  ],
  provides: [Provider(Env)({ value: {} })],
  exports: [Mailer],
});
const _explicit = Module.scoped(Explicit, (ctx) => OkAsync(ctx.get(Mailer)));

// A runtime flag is not a literal, so the conditional distributes over both
// arms and lands on the union that OWES the ports — the safe direction: a graph
// that might instrument must have provided for it.
declare const decided: boolean;
const Dynamic = Module("Dynamic")({
  imports: [mailer({ adapter: recordingMailer(mailRecorder()), instrumented: decided })],
  exports: [Mailer],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: a maybe-instrumented mailer owes the three ports.
const _dynamic = Module.scoped(Dynamic, (ctx) => OkAsync(ctx.get(Mailer)));

void _instrumented;
void _unobserved;
void _plain;
void _explicit;
void _dynamic;
