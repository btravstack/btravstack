import { fromSchema, type SchemaIssues } from "@unthrown/standard-schema";
import type { Result } from "unthrown";
import { z } from "zod";

/**
 * A port, read the way an environment variable actually arrives: as a string.
 *
 * The non-empty string in front of the coercion is the load-bearing part.
 * Coercion is `Number()` underneath, and `Number("")` is `0` — so a bare
 * `PORT=` would bind the ephemeral port `0` rather than be reported, and a
 * port's `min` **is** `0` because an ephemeral bind has to stay expressible, so
 * the bounds cannot catch it. An empty value is a configuration error, not an
 * absent one: `.default(...)` applies only when the variable is genuinely
 * missing.
 *
 * With that guard, the bounds handle the rest — `PORT=abc` is `NaN`,
 * `PORT=3.5` is not an integer, `PORT=99999` is out of range.
 */
const port = (fallback: number) =>
  z
    .string()
    .trim()
    .min(1)
    .pipe(z.coerce.number<string>().int().min(0).max(65_535))
    .default(fallback);

const environment = z.object({
  PORT: port(3000),
  PROBE_PORT: port(9000),
});

/** The validated environment: every field present, typed, and in range. */
export type Env = z.infer<typeof environment>;

// `fromSchema` is CURRIED — it takes the schema and hands back the validator.
const validate = fromSchema(environment);

/**
 * Validates the process environment **as a value**.
 *
 * A schema's own `.parse()` throws, which `unthrown/no-throw` bans and which
 * would contradict the example it appears in. `@unthrown/standard-schema` makes
 * the issues the modeled `E`, so the entry point folds a bad environment the
 * same way it folds any other anticipated failure.
 */
export const readEnv = (source: typeof process.env = process.env): Result<Env, SchemaIssues> =>
  validate(source);

const nameOf = (segment: NonNullable<SchemaIssues[number]["path"]>[number]): string =>
  String(typeof segment === "object" ? segment.key : segment);

/** One line per issue, each naming the variable it is about. */
export const describeEnvIssues = (issues: SchemaIssues): string =>
  issues
    .map(
      (issue) => `${(issue.path ?? []).map(nameOf).join(".") || "(environment)"}: ${issue.message}`,
    )
    .join("\n");
