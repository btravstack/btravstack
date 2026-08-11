import type { DrainReport } from "./drain.js";

export type KernelEvent =
  | { readonly type: "building" }
  | { readonly type: "serving"; readonly runtime: string }
  | { readonly type: "draining"; readonly inFlight: number }
  | { readonly type: "drained"; readonly report: DrainReport }
  | { readonly type: "stopping" }
  | { readonly type: "exited" }
  | { readonly type: "teardownError"; readonly port: string; readonly cause: unknown }
  | { readonly type: "uncaught"; readonly cause: unknown };

export type EventSink = (event: KernelEvent) => void;

export const stderrSink: EventSink = (event) => {
  process.stderr.write(`${JSON.stringify(event)}\n`);
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
