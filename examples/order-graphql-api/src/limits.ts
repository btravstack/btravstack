import {
  Kind,
  getOperationAST,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import type { Plugin } from "graphql-yoga";
import { createGraphQLError } from "graphql-yoga";

/** The aliases one operation runs: its own, and each fragment's once per spread. */
const aliasesOf = (document: DocumentNode, operationName: string | null | undefined): number => {
  const operation = getOperationAST(document, operationName);
  if (operation === null || operation === undefined) return 0;
  const fragments = new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((fragment) => [fragment.name.value, fragment]),
  );
  // Memoized per fragment: a fragment spreading another twice, nested, would
  // otherwise make the count itself exponential.
  const counted = new Map<string, number>();
  const inSet = (selections: SelectionSetNode): number =>
    selections.selections.reduce((count, selection) => {
      if (selection.kind === Kind.FIELD)
        return (
          count +
          (selection.alias === undefined ? 0 : 1) +
          (selection.selectionSet === undefined ? 0 : inSet(selection.selectionSet))
        );
      if (selection.kind === Kind.INLINE_FRAGMENT) return count + inSet(selection.selectionSet);
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (fragment === undefined) return count;
      if (!counted.has(name)) counted.set(name, inSet(fragment.selectionSet));
      return count + (counted.get(name) ?? 0);
    }, 0);
  return inSet(operation.selectionSet);
};

/**
 * Refuses an operation that runs more than `limit` aliases — its own and
 * those its fragments bring — before any resolver runs, so a refused
 * operation calls no service, a mutation's included. One alias is one more
 * resolver run, which is what makes an alias list the cheapest amplification a
 * caller can send. Only the operation `operationName` selects is counted, so
 * a document's other operations never refuse it.
 */
// ponytail: counts aliases, not cost — a cost or depth budget (graphql-armor) when a schema grows lists of lists
export const maxAliases = (limit: number): Plugin => {
  const refused = (document: DocumentNode, operationName: string | null | undefined) =>
    aliasesOf(document, operationName) > limit
      ? {
          errors: [
            createGraphQLError(`An operation may name at most ${String(limit)} aliases`, {
              extensions: { code: "TOO_MANY_ALIASES" },
            }),
          ],
        }
      : undefined;
  return {
    onExecute: ({ args, setResultAndStopExecution }) => {
      const result = refused(args.document, args.operationName);
      if (result !== undefined) setResultAndStopExecution(result);
    },
    onSubscribe: ({ args, setResultAndStopExecution }) => {
      const result = refused(args.document, args.operationName);
      if (result !== undefined) setResultAndStopExecution(result);
    },
  };
};
