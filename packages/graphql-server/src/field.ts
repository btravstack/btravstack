import type { GraphQLError } from "graphql";
import type { AsyncResult, Result } from "unthrown";

/**
 * A resolver's answer from a `Result`, so a modeled failure is never thrown by
 * hand. `Ok` is the field's value. `Err` is the `GraphQLError` the resolver's
 * own triage minted from its `E` — an exhaustive `mapErrCases`, so widening
 * `E` fails every resolver that folds it — and GraphQL reports it on this
 * field's path, aliases and list indexes included, while its siblings resolve.
 * A defect's cause is raised as it is: Yoga masks it to `Unexpected error.`
 * and `graphql()` reports it to `Observers`.
 */
export const fieldResult = async <T>(
  result: AsyncResult<T, GraphQLError> | Result<T, GraphQLError>,
): Promise<T> => {
  const settled = await result;
  // oxlint-disable-next-line unthrown/no-throw -- a resolver reports its field's error by throwing it
  if (settled.isDefect()) throw settled.cause;
  // oxlint-disable-next-line unthrown/no-throw -- a resolver reports its field's error by throwing it
  if (settled.isErr()) throw settled.error;
  return settled.value;
};
