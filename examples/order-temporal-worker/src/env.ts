import { describeEnvIssues, port } from "@btravstack/example-order-config";
import { fromSchema, type SchemaIssues } from "@unthrown/standard-schema";
import type { Result } from "unthrown";
import { z } from "zod";

const environment = z.object({
  PROBE_PORT: port(9000),
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
 * same way it folds any other anticipated failure. `port` and the issue
 * formatter are the shared ones — see `order-config` for why the non-empty
 * string in front of the coercion is load-bearing.
 */
export const readEnv = (source: typeof process.env = process.env): Result<Env, SchemaIssues> =>
  validate(source);

export { describeEnvIssues };
