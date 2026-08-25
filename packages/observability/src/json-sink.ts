import type { Line, Sink } from "./logger.js";

/**
 * An `Error`'s `message` and `stack` are **non-enumerable**, so
 * `JSON.stringify` renders a thrown one as `{}` — the line that exists to carry
 * a failure would carry nothing. Walks `cause` chains so a wrapped failure keeps
 * its origin.
 */
const renderCause = (cause: unknown, depth = 0): unknown => {
  if (!(cause instanceof Error)) return cause;
  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    // Bounded: an error whose `cause` points back at itself is fatal to a
    // renderer that follows it.
    ...(cause.cause === undefined || depth >= 4
      ? {}
      : { cause: renderCause(cause.cause, depth + 1) }),
  };
};

/**
 * One JSON object per line on `stream`.
 *
 * The caller's attributes are spread FIRST and the line's own fields after them,
 * and that order is the precedence: an `attributes: { level: "info" }` cannot
 * rewrite an `error` line's severity, nor its `traceId`.
 *
 * The unit's ids are spread at the top level rather than nested under `unit`,
 * because `traceId` is the field an operator searches.
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

// A payload `JSON.stringify` refuses must not cost the line: the message and
// its severity survive, and the part that could not be rendered says so.
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
