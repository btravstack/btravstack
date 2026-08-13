import type { SchemaIssues } from "@unthrown/standard-schema";
import { z } from "zod";

/**
 * A whole number, read the way an environment variable actually arrives: as a
 * string.
 *
 * The non-empty string in front of the coercion is the load-bearing part.
 * Coercion is `Number()` underneath, and `Number("")` is `0` — so a bare
 * `PROBE_PORT=` would bind the ephemeral port `0`, a probe endpoint nobody can
 * find, and a bare `CONCURRENCY=` would build a worker that consumes nothing.
 * The bounds cannot catch either, because a port's `min` **is** `0`: an
 * ephemeral bind has to stay expressible. An empty value is a configuration
 * error, not an absent one — `.default(...)` applies only when the variable is
 * genuinely missing.
 *
 * With that guard, the bounds handle the rest — `abc` is `NaN`, `3.5` is not an
 * integer, and anything outside `min`/`max` is out of range.
 *
 * The `<string>` type argument is needed because `z.coerce.number()`'s input is
 * `unknown`, which `.pipe` will not accept from a `string`.
 */
export const wholeNumber = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .pipe(z.coerce.number<string>().int().min(min).max(max))
    .default(fallback);

/** A port: a whole number in the range the OS will accept, `0` included. */
export const port = (fallback: number) => wholeNumber(fallback, 0, 65_535);

const nameOf = (segment: NonNullable<SchemaIssues[number]["path"]>[number]): string =>
  String(typeof segment === "object" ? segment.key : segment);

/** One line per issue, each naming the variable it is about. */
export const describeEnvIssues = (issues: SchemaIssues): string =>
  issues
    .map(
      (issue) => `${(issue.path ?? []).map(nameOf).join(".") || "(environment)"}: ${issue.message}`,
    )
    .join("\n");
