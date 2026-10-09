import { Kind, type SelectionSetNode, type ValidationRule } from "graphql";
import type { Plugin } from "graphql-yoga";
import { createGraphQLError } from "graphql-yoga";

const aliasesIn = (selections: SelectionSetNode): number =>
  selections.selections.reduce(
    (count, selection) =>
      selection.kind === Kind.FIELD
        ? count +
          (selection.alias === undefined ? 0 : 1) +
          (selection.selectionSet === undefined ? 0 : aliasesIn(selection.selectionSet))
        : selection.kind === Kind.INLINE_FRAGMENT
          ? count + aliasesIn(selection.selectionSet)
          : count,
    0,
  );

/**
 * Refuses an operation naming more than `limit` aliases — its own and those of
 * the fragments it references — as a validation error. Validation runs before
 * execution, so a refused operation calls no service, a mutation's included.
 * One alias is one more resolver run, which is what makes an alias list the
 * cheapest amplification a caller can send. Each operation in a document is
 * counted on its own, so a second one never pushes the first over.
 */
// ponytail: counts aliases, not cost — a cost or depth budget (graphql-armor) when a schema grows lists of lists
export const maxAliases = (limit: number): Plugin => {
  const rule: ValidationRule = (context) => ({
    OperationDefinition: (operation) => {
      const aliases = [operation, ...context.getRecursivelyReferencedFragments(operation)].reduce(
        (count, node) => count + aliasesIn(node.selectionSet),
        0,
      );
      if (aliases > limit)
        context.reportError(
          createGraphQLError(`An operation may name at most ${String(limit)} aliases`, {
            nodes: [operation],
            extensions: { code: "TOO_MANY_ALIASES" },
          }),
        );
    },
  });
  return { onValidate: ({ addValidationRule }) => addValidationRule(rule) };
};
