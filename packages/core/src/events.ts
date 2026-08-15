import type { DrainReport } from "./drain.js";

export type KernelEvent =
  | { readonly type: "building" }
  | { readonly type: "startFailed"; readonly cause: unknown }
  | { readonly type: "serving"; readonly runtime: string }
  | { readonly type: "draining"; readonly inFlight: number }
  | { readonly type: "drained"; readonly report: DrainReport }
  | { readonly type: "stopping" }
  | { readonly type: "exited" }
  | { readonly type: "teardownError"; readonly port: string; readonly cause: unknown }
  | { readonly type: "uncaught"; readonly cause: unknown };

export type EventSink = (event: KernelEvent) => void;

// `JSON.stringify` skips non-enumerable properties, and an `Error`'s `message`
// and `stack` are both non-enumerable — so `uncaught` and `teardownError`, the
// two events that exist to carry a cause, would serialise it as `{}` and the
// default crash report would name no error at all.
const withErrors = (_key: string, value: unknown): unknown =>
  value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
    : value;

// A cause `JSON.stringify` refuses outright — a circular object is the common
// one — must not cost the whole event. The throw would be swallowed by
// `safeSink` (correctly: a broken reporter cannot take the process down), and
// the crash would then be reported *nowhere*. So the event is written without
// the part that could not be rendered.
const render = (event: KernelEvent): string => {
  try {
    return JSON.stringify(event, withErrors);
  } catch {
    return JSON.stringify({ type: event.type, cause: "[unserialisable]" });
  }
};

export const stderrSink: EventSink = (event) => {
  process.stderr.write(`${render(event)}\n`);
};

// A broken reporter must not take the process down mid-shutdown — the same
// rule di applies to a throwing `onTeardownError`. There is nowhere left to
// report a broken reporter to.
export const safeSink =
  (sink: EventSink): EventSink =>
  (event) => {
    try {
      sink(event);
    } catch {
      // deliberately swallowed
    }
  };
