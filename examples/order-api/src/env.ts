import { fromSchema, type SchemaIssues } from "@unthrown/standard-schema";
import type { Result } from "unthrown";
import { z } from "zod";

/**
 * A port, read the way an environment variable actually arrives: as a string.
 *
 * The coercion is `Number()` underneath, which is only a trap **without** the
 * bounds that follow it: `PORT=abc` is `NaN` and fails `int()`, `PORT=3.5`
 * fails it too, and `PORT=99999` fails `max()`. The one case the bounds cannot
 * catch is an empty or whitespace-only value, which is `0` — and a port's `min`
 * **is** `0`, because `0` is the ephemeral bind the specs assert. So `PORT=`
 * binds an ephemeral port rather than being reported; a field whose `min` is at
 * least `1` (`order-worker`'s `CONCURRENCY`) has no such hole.
 */
const port = (fallback: number) => z.coerce.number().int().min(0).max(65_535).default(fallback);

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
