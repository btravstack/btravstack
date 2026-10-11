import type { Line, Sink } from "./logger.js";

const DIAGNOSTIC_FIELDS = [
  "_tag",
  "sqlState",
  "constraint",
  "table",
  "database",
  "role",
  "bypass",
  "port",
];

/**
 * An `Error`'s `message` and `stack` are **non-enumerable**, so
 * `JSON.stringify` renders a thrown one as `{}` — the line that exists to carry
 * a failure would carry nothing. Walks `cause` chains so a wrapped failure keeps
 * its origin.
 */
const renderCause = (cause: unknown, depth = 0, parents = new Set<Error>()): unknown => {
  if (!(cause instanceof Error)) return cause;
  if (parents.has(cause)) return "[circular]";
  const ancestors = new Set(parents).add(cause);
  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    // A fixed scalar whitelist avoids copying secret-bearing or personal payload fields.
    ...Object.fromEntries(
      DIAGNOSTIC_FIELDS.flatMap((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(cause, key);
        const value: unknown = descriptor?.value;
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? [[key, value]]
          : [];
      }),
    ),
    ...(cause.cause === undefined || depth >= 4
      ? {}
      : { cause: renderCause(cause.cause, depth + 1, ancestors) }),
    ...(cause instanceof AggregateError && depth < 4
      ? {
          errors: cause.errors
            .slice(0, 16)
            .map((error: unknown) => renderCause(error, depth + 1, ancestors)),
          ...(cause.errors.length > 16 ? { omittedErrors: cause.errors.length - 16 } : {}),
        }
      : {}),
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

// Under its own key, as the line renders it: a `toJSON(key)` may answer
// differently for `cause` than for the root.
const serialises = (key: string, value: unknown): boolean => {
  try {
    JSON.stringify({ [key]: value });
    return true;
  } catch {
    return false;
  }
};

// A payload `JSON.stringify` refuses must not cost the line: every field that
// renders survives — the unit's ids included — and `unserialisable` names the
// ones that did not, last so no attribute can rewrite it.
const safeStringify = (rendered: Record<string, unknown>): string => {
  try {
    return JSON.stringify(rendered);
  } catch {
    const kept = Object.entries(rendered).filter(([key, value]) => serialises(key, value));
    return JSON.stringify({
      ...Object.fromEntries(kept),
      unserialisable: Object.keys(rendered).filter((key) => !serialises(key, rendered[key])),
    });
  }
};
