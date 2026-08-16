import type { Line, Sink } from "./logger.js";

/**
 * An `Error`'s `message` and `stack` are **non-enumerable**, so
 * `JSON.stringify` renders a thrown one as `{}` — the line that exists to
 * carry a failure would carry nothing. The kernel's `stderrSink` normalises
 * the same way for the same reason; this is that rule applied to a log line,
 * and it walks `cause` chains so a wrapped failure keeps its origin.
 */
const renderCause = (cause: unknown, depth = 0): unknown => {
  if (!(cause instanceof Error)) return cause;
  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    // Bounded: an error whose `cause` points back at itself is rare and fatal
    // to a renderer that follows it, and four levels is more than any real
    // wrap depth.
    ...(cause.cause === undefined || depth >= 4
      ? {}
      : { cause: renderCause(cause.cause, depth + 1) }),
  };
};

/**
 * One JSON object per line on `stream`, the shape every log backend already
 * reads and the same one the kernel's `stderrSink` writes its events in.
 *
 * The caller's attributes are spread **first** and the line's own fields
 * after them, and that order is the precedence: an `attributes: { level:
 * "info" }` cannot rewrite an `error` line's severity, nor its `traceId`,
 * because the sink writes those last. A stream where a caller can forge the
 * severity is a stream nobody can trust.
 *
 * The unit's ids are spread at the top level rather than nested under `unit`:
 * a log backend indexes fields, and `traceId` is the field an operator
 * searches.
 */
export const jsonSink =
  (stream: { readonly write: (chunk: string) => unknown } = process.stdout): Sink =>
  (line: Line) => {
    const { level, message, attributes, cause, time, unit } = line;
    const rendered = {
      ...attributes,
      time: new Date(time).toISOString(),
      level,
      message,
      ...(unit === undefined ? {} : unit),
      ...(cause === undefined ? {} : { cause: renderCause(cause) }),
    };
    stream.write(`${safeStringify(rendered)}\n`);
  };

// A payload `JSON.stringify` refuses — a circular attribute value reaching in
// through `cause` is the plausible one — must not cost the line. The message
// and its severity survive; the part that could not be rendered says so.
const safeStringify = (rendered: Record<string, unknown>): string => {
  try {
    return JSON.stringify(rendered);
  } catch {
    return JSON.stringify({
      time: rendered["time"],
      level: rendered["level"],
      message: rendered["message"],
      cause: "[unserialisable]",
    });
  }
};
