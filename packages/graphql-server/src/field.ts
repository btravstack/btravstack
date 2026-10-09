import type { GraphQLError } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import type { AsyncResult, Result } from "unthrown";

/**
 * A resolver's answer from a `Result`, so a modeled failure is never thrown by
 * hand. `Ok` is the field's value. `Err` is the `GraphQLError` the resolver's
 * own triage minted from its `E` — an exhaustive `mapErrCases`, so widening
 * `E` fails every resolver that folds it — and GraphQL reports it on this
 * field's path, aliases and list indexes included, while its siblings resolve:
 * its message and `extensions` reach the client, its `originalError` does not.
 * A defect is masked to `Unexpected error.` whatever its cause, and `graphql()`
 * reports it to `Observers`.
 *
 * **It answers a `Promise`, and that is the boundary**: a GraphQL resolver
 * returns a value or a promise and reports a field's error by rejecting, so
 * this is where a `Result` leaves for GraphQL's own channel — the one place a
 * resolver needs, as `runMain` is for a process.
 */
export const fieldResult = async <T>(
  result: AsyncResult<T, GraphQLError> | Result<T, GraphQLError>,
): Promise<T> => {
  const settled = await result;
  // Yoga masks by the thrown value's shape: a `GraphQLError` cause would be
  // exposed as a refusal, so a defect is never thrown as itself.
  if (settled.isDefect())
    // oxlint-disable-next-line unthrown/no-throw -- a resolver reports its field's error by throwing it
    throw new Error("fieldResult: the field's result was a defect", { cause: settled.cause });
  // Rebuilt without `originalError`, which would make Yoga mask the refusal —
  // and by Yoga, whose `graphql` may be another module instance than ours.
  if (settled.isErr())
    // oxlint-disable-next-line unthrown/no-throw -- a resolver reports its field's error by throwing it
    throw createGraphQLError(settled.error.message, { extensions: settled.error.extensions });
  return settled.value;
};
