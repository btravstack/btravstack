import type { ValidationRule } from "graphql";
import type { Plugin } from "graphql-yoga";
import { createGraphQLError } from "graphql-yoga";

/**
 * Refuses an operation naming more than `limit` aliases, as a validation
 * error — validation runs before execution, so a refused operation calls no
 * service, a mutation's included. One alias is one more resolver run, which is
 * what makes an alias list the cheapest amplification a caller can send.
 */
// ponytail: counts aliases, not cost — a cost or depth budget (graphql-armor) when a schema grows lists of lists
export const maxAliases = (limit: number): Plugin => {
  const rule: ValidationRule = (context) => {
    let aliases = 0;
    return {
      Field: (node) => {
        if (node.alias !== undefined && ++aliases === limit + 1)
          context.reportError(
            createGraphQLError(`An operation may name at most ${String(limit)} aliases`, {
              nodes: [node],
              extensions: { code: "TOO_MANY_ALIASES" },
            }),
          );
      },
    };
  };
  return { onValidate: ({ addValidationRule }) => addValidationRule(rule) };
};
