import type { DrainReport } from "./drain.js";

export type KernelEvent =
  | { readonly type: "building" }
  | { readonly type: "startFailed"; readonly cause: unknown }
  | {
      readonly type: "serving";
      readonly runtime: string;
      /**
       * Whatever the runtime published on `Serving.info`. `unknown` because the
       * kernel does not know a runtime's `Info` at the event union — it is read
       * off the module at `start`'s call site, not here — and a sink is
       * serialising it anyway. A generic `KernelEvent<Info>` would infect
       * `EventSink`, `stderrSink` and every adapter for one field none of them
       * reads structurally.
       */
      readonly info: unknown;
      /**
       * The port the kernel's own probe listener bound, `undefined` when probes
       * are off. Its own field rather than folded into `info`: the probe server
       * is the kernel's, not the runtime's, so publishing it as something the
       * runtime said would be a small lie.
       */
      readonly probePort: number | undefined;
    }
  | { readonly type: "draining"; readonly inFlight: number }
  | { readonly type: "drained"; readonly report: DrainReport }
  | {
      /**
       * The kernel stopped WAITING for a phase that has no deadline of its own,
       * and reported anyway. Without it a stop that ran long and a stop that
       * finished are the same two lines on stderr (`stopping`, `exited`), which
       * is the silence `ExitReport.abandonedAt` exists to end.
       */
      readonly type: "stoppedWaiting";
      /** `"stop"` for `Serving.stop` and the finalisers, `"build"` for a graph that never served. */
      readonly phase: "build" | "stop";
      /** The deadline that expired, or `undefined` when a second signal cut the wait short. */
      readonly afterMs: number | undefined;
    }
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
