import { fromSchema, type SchemaIssues } from "@unthrown/standard-schema";
import type { Result } from "unthrown";
import { z } from "zod";

/**
 * A whole number, read the way an environment variable actually arrives: as a
 * string.
 *
 * The coercion is `Number()` underneath, which is only a trap **without** the
 * bounds that follow it: `PROBE_PORT=abc` is `NaN` and fails `int()`, and
 * `PROBE_PORT=3.5` fails it too. Note the one case the bounds cannot catch —
 * an empty or whitespace-only value is `0`, so a field whose `min` is `0`
 * accepts `PROBE_PORT=` as an ephemeral bind. Every field whose `min` is at
 * least `1` rejects it.
 */
const wholeNumber = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const environment = z.object({
  PROBE_PORT: wholeNumber(9000, 0, 65_535),
  /** `host:port` of the Temporal frontend service. */
  TEMPORAL_ADDRESS: z.string().min(1).default("127.0.0.1:7233"),
  /**
   * The namespace this worker polls in. Half of the pair the runtime publishes
   * on `Serving.info`, and half of what decides which work it is ever handed.
   */
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
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
