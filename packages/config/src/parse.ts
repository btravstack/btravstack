import type { StandardSchemaV1 } from "@standard-schema/spec";
import { fromSchema } from "@unthrown/standard-schema";
import { Err, fromSafeThrowable, isDefect, Ok, type Result } from "unthrown";

import { ConfigInvalid, type ConfigIssue } from "./errors.js";
import type { AnyConfigAdapter } from "./slice.js";
import { variableName } from "./variable.js";

/** One validator per variable — the prefix mapping needs each key's own name. */
export type Shape = Record<string, StandardSchemaV1>;

/**
 * Parse every key of one slice, collecting issues rather than stopping at the
 * first: an operator fixing three variables should learn all three now.
 */
export const parseShape = (
  prefix: string,
  shape: Shape,
  source: Record<string, string | undefined>,
): Result<Record<string, unknown>, readonly ConfigIssue[]> => {
  const value: Record<string, unknown> = {};
  const issues: ConfigIssue[] = [];

  for (const [key, schema] of Object.entries(shape)) {
    const variable = variableName(prefix, key);
    // `fromSchema` throws a raw `TypeError` when handed a schema that
    // validates *asynchronously* — a synchronous `Result` cannot represent
    // pending work — and that throw happens at the call itself, past
    // `fromSchema`'s own boundary. Wrapping the call turns it into a
    // `Defect` like any other crash, instead of letting it escape
    // `Config.parse` as an uncaught exception; `.flatMap` then unwraps the
    // one extra layer `fromSafeThrowable` adds, letting a Defect from either
    // source pass through untouched.
    const parsed = fromSafeThrowable(() => fromSchema(schema)(source[variable]))().flatMap(
      (result) => result,
    );

    // A crash inside validation is a defect in the schema, not a wrong
    // environment: propagate it on the defect channel rather than folding it
    // into `issues`, which would misreport a validator bug as "fix this
    // variable" and, downstream, exit `EX_CONFIG` where the design says
    // `EX_SOFTWARE`. The cast is sound but not checkable: a `Defect` carries
    // no `T`/`E`-dependent data, so it is compatible with any `Result` type,
    // but the compiler can't see that across two structurally-unrelated
    // instantiations.
    if (isDefect(parsed)) {
      return parsed as unknown as Result<Record<string, unknown>, readonly ConfigIssue[]>;
    }

    if (parsed.isOk()) {
      value[key] = parsed.value;
    } else {
      for (const issue of parsed.error) issues.push({ variable, message: issue.message });
    }
  }

  return issues.length > 0 ? Err(issues) : Ok(value);
};

/**
 * Validate every config adapter against one source, aggregating across all of
 * them.
 *
 * Deliberately not short-circuiting *on modeled issues*: three wrong
 * variables should cost one deploy, not three. The success value is `void`
 * — each adapter's own provider parses again when the graph is built, from
 * the same injected source, so there is nothing to carry across and no state
 * to keep in step.
 *
 * A `Defect` from any one adapter, by contrast, does stop the walk: it is a
 * bug in that adapter's own schema, not a wrong environment, and aggregating
 * further adapters cannot make it any more or less true. Propagating it
 * immediately keeps `Config.parse`'s promise — a `Defect` never becomes a
 * `ConfigInvalid` issue, the same rule `parseShape` applies per key.
 */
export const parseAll = (
  adapters: readonly AnyConfigAdapter[],
  source: Record<string, string | undefined>,
): Result<void, ConfigInvalid> => {
  const issues: ConfigIssue[] = [];

  for (const adapter of adapters) {
    const parsed = parseShape(adapter.prefix, adapter.shape, source);
    if (isDefect(parsed)) return parsed as unknown as Result<void, ConfigInvalid>;
    if (parsed.isErr()) issues.push(...parsed.error);
  }

  return issues.length > 0 ? Err(new ConfigInvalid({ issues })) : Ok();
};
